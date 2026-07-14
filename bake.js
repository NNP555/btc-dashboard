#!/usr/bin/env node
/**
 * bake.js — серверная пересборка снимка BTC-дэшборда (Фаза B).
 *
 * Запуск:  node bake.js            → пишет ./data.json рядом с собой
 * В CI:    GitHub Actions cron → node bake.js → commit data.json → GH/CF Pages
 *
 * Зачем сервер, а не браузер: у bitcoin-data бесплатный лимит ~8 запросов/час.
 * Из браузера ~9 метрик → 429 («шахматка» live/снимок). Здесь запросы ДОЗИРУЮТСЯ
 * (≤7 к bitcoin-data за прогон, стальные метрики ротируются по свежести).
 *
 * Что делает:
 *  A2  — канонический дневной ряд цены (Kraken OHLC); ВСЕ ценовые производные
 *        (MA/RSI/Mayer/PiCycle/2Y MA) фронт считает из него → уходит «шахматка».
 *  A1  — накапливает историю (priceSeries + hist[] по каждой метрике) в data.json;
 *        в git-варианте версии data.json = бесплатный лог для бэктеста.
 *  A5  — отсечка аномалий: скачок >50% к прошлому значению → флаг, старое значение.
 *
 * Node 18+ (глобальный fetch). Раннеры GitHub в US → Binance НЕ используем
 * (гео-блок); берём Kraken/Coinbase/Deribit/DefiLlama/bitcoin-data/alternative.me.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, 'data.json');

const TODAY = new Date().toISOString().slice(0, 10);
const HIST_CAP = 400;                 // сколько точек истории держать на метрику
const ANOMALY = 0.5;                  // >50% скачок к прошлому значению = аномалия
const VOLATILE = new Set(['price', 'etfFlow', 'funding', 'cbPrice', 'deribitIndex', 'oiUsd', 'dvol']); // рыночные метрики законно скачут — отсечку аномалий к ним не применяем
const BD_BUDGET = 7;                  // макс. запросов к bitcoin-data за прогон (лимит 8/час)

// ---------- утилиты ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function jget(url, { timeout = 15000, headers = {} } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { accept: 'application/json,text/html', 'user-agent': 'btc-dashboard-bake', ...headers } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const ct = r.headers.get('content-type') || '';
    return ct.includes('json') ? await r.json() : await r.text();
  } finally { clearTimeout(t); }
}

// прошлый снимок — для накопления истории (A1) и отсечки аномалий (A5)
let prev = { metrics: {}, priceSeries: [] };
try { prev = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) { /* первый запуск */ }
const prevM = prev.metrics || {};

const snap = {
  asof: new Date().toISOString(),
  priceSeries: Array.isArray(prev.priceSeries) ? prev.priceSeries.slice() : [],
  ath: prev.ath || 126198,
  metrics: {},
  flags: {},
  log: [],
};
const log = (...a) => { snap.log.push(a.join(' ')); console.log(...a); };

/** Записать метрику со значением/датой + накопить историю + отсечь аномалию. */
function put(key, value, date, src) {
  if (value == null || !isFinite(value)) { log('· skip', key, '(нет значения)'); if (prevM[key]) snap.metrics[key] = prevM[key]; return; }
  const p = prevM[key];
  // A5: аномальный скачок → оставить старое, пометить
  if (!VOLATILE.has(key) && p && p.v != null && Math.abs(p.v) > 1e-12 && Math.abs(value - p.v) / Math.abs(p.v) > ANOMALY) {
    snap.metrics[key] = { ...p, anom: { rejected: value, at: TODAY } };
    snap.flags[key] = 'anomaly'; log('! anomaly', key, p.v, '→', value, '(отклонено)'); return;
  }
  // A1: история
  let hist = (p && Array.isArray(p.hist)) ? p.hist.slice() : [];
  if (!hist.length || hist[hist.length - 1][0] !== date) hist.push([date, value]);
  else hist[hist.length - 1] = [date, value];
  if (hist.length > HIST_CAP) hist = hist.slice(-HIST_CAP);
  snap.metrics[key] = { v: value, d: date, src, hist };
  snap.flags[key] = 'ok';
}

// ---------- A2: канонический ряд цены (Kraken OHLC, дневки) ----------
async function canonicalPrice() {
  try {
    const j = await jget('https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1440');
    const key = Object.keys(j.result).find(k => k !== 'last');
    const rows = j.result[key];                         // [ [time,o,h,l,c,vwap,vol,cnt], ... ]
    const byDate = new Map(snap.priceSeries.map(p => [p.d, p.c]));
    for (const r of rows) {
      const d = new Date(r[0] * 1000).toISOString().slice(0, 10);
      byDate.set(d, +r[4]);                              // close
    }
    snap.priceSeries = [...byDate.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([d, c]) => ({ d, c })).slice(-HIST_CAP * 2);
    const last = snap.priceSeries[snap.priceSeries.length - 1];
    snap.ath = Math.max(snap.ath, ...snap.priceSeries.map(p => p.c));
    put('price', last.c, last.d, 'Kraken OHLC');
    log('Kraken price ✓', snap.priceSeries.length, 'дней, посл.', last.c, '@', last.d);
  } catch (e) { log('Kraken price ✕', e.message); if (prevM.price) snap.metrics.price = prevM.price; }
}

// ---------- bitcoin-data (дозированно) ----------
// slug -> ключ метрики. Поле в ответе НЕ угадываем: берём числовое поле (кроме unixTs).
const BD = {
  'mvrv-zscore': 'mvrvZ', 'nupl': 'nupl', 'sopr': 'sopr', 'puell-multiple': 'puell',
  'rhodl-ratio': 'rhodl', 'hodl-bank': 'hodlBank',
  // ротируемые (реже, чтобы уложиться в лимит):
  'realized-price': 'realized', 'sth-realized-price': 'sthRealized', 'average-dormancy': 'dormancy',
  'lth-sopr': 'lthSopr', 'sth-sopr': 'sthSopr', 'reserve-risk': 'reserveRiskPub',
  'lth-mvrv': 'lthMvrv', 'sth-mvrv': 'sthMvrv', 'nupl-lth': 'nuplLth', 'nupl-sth': 'nuplSth',
};
const BD_CORE = ['mvrv-zscore', 'nupl', 'sopr', 'puell-multiple', 'rhodl-ratio', 'hodl-bank'];
// Фаза D: приоритет КОГОРТАМ. 8 когорт впереди, realized-price — в хвост.
// reserve-risk убран из ротации: reserveRisk считаем сами (= price / HODL Bank), а reserveRiskPub нигде не используется.
const BD_ROTATE = ['lth-sopr', 'nupl-lth', 'sth-sopr', 'nupl-sth', 'lth-mvrv', 'sth-mvrv', 'sth-realized-price', 'average-dormancy', 'realized-price'];

function bdVal(obj) {
  const date = obj.d || obj.theDate || TODAY;
  for (const [k, v] of Object.entries(obj)) {                 // bitcoin-data отдаёт значения то числом, то строкой
    if (k === 'unixTs' || k === 'd' || k === 'theDate') continue;
    const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' && isFinite(+v) ? +v : null);
    if (n != null) return { value: n, date };
  }
  return null;
}
async function bitcoinData(slugs) {
  for (const slug of slugs) {
    try {
      const j = await jget(`https://bitcoin-data.com/v1/${slug}/last`, { timeout: 20000 });
      const r = bdVal(j);
      if (r) { put(BD[slug], r.value, r.date, 'bitcoin-data:' + slug); log('bitcoin-data', slug, '✓', r.value, '@', r.date); }
      else { log('bitcoin-data', slug, '✕ нет числового поля'); }
    } catch (e) { log('bitcoin-data', slug, '✕', e.message); if (prevM[BD[slug]]) snap.metrics[BD[slug]] = prevM[BD[slug]]; }
    await sleep(1500);                                   // мягко к rate-limit
  }
}
// Выбор ротируемых. Приоритет: сначала слаги, которые ЕЩЁ НИ РАЗУ не приходили
// (в порядке BD_ROTATE — когорты впереди), затем самые «стальные» из уже имеющихся.
// Так все 8 когорт гарантированно получат первое значение за первые ~8 прогонов (≈4 дня),
// прежде чем realized-price начнёт заново обновляться.
function pickRotating(n) {
  const has = slug => { const p = prevM[BD[slug]]; return !!(p && p.d != null); };
  const age = slug => { const p = prevM[BD[slug]]; return p && p.d ? (Date.now() - new Date(p.d)) : 9e15; };
  const missing = BD_ROTATE.filter(s => !has(s));                        // ещё ни разу не пришли
  const present = BD_ROTATE.filter(has).sort((a, b) => age(b) - age(a)); // старые вперёд
  return [...missing, ...present].slice(0, n);
}

// ---------- Deribit (funding, OI, index, DVOL) ----------
async function deribit() {
  try {
    const t = await jget('https://www.deribit.com/api/v2/public/ticker?instrument_name=BTC-PERPETUAL');
    const r = t.result || {};
    if (r.funding_8h != null) put('funding', r.funding_8h * 100, TODAY, 'Deribit');
    if (r.open_interest != null) put('oiUsd', r.open_interest, TODAY, 'Deribit');
    if (r.index_price != null) put('deribitIndex', r.index_price, TODAY, 'Deribit');
    log('Deribit ticker ✓');
  } catch (e) { log('Deribit ticker ✕', e.message); }
  try {
    const end = Date.now(), start = end - 3 * 864e5;
    const v = await jget(`https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=BTC&start_timestamp=${start}&end_timestamp=${end}&resolution=3600`);
    const d = v.result && v.result.data;
    if (d && d.length) put('dvol', d[d.length - 1][4], TODAY, 'Deribit DVOL');  // [ts,o,h,l,close]
    log('Deribit DVOL ✓');
  } catch (e) { log('Deribit DVOL ✕', e.message); }
}

// ---------- прочие бесплатные источники ----------
async function others() {
  try { const c = await jget('https://api.coinbase.com/v2/prices/BTC-USD/spot'); if (c?.data?.amount) put('cbPrice', +c.data.amount, TODAY, 'Coinbase'); log('Coinbase ✓'); }
  catch (e) { log('Coinbase ✕', e.message); }
  try { const f = await jget('https://api.alternative.me/fng/?limit=1'); const v = f?.data?.[0]?.value; if (v != null) put('fng', +v, TODAY, 'alternative.me'); log('F&G ✓'); }
  catch (e) { log('F&G ✕', e.message); }
  try { const s = await jget('https://stablecoins.llama.fi/stablecoins?includePrices=false'); const tot = s?.peggedAssets?.reduce((a, x) => a + (x.circulating?.peggedUSD || 0), 0); if (tot) put('stablecoin', tot, TODAY, 'DefiLlama'); log('DefiLlama ✓'); }
  catch (e) { log('DefiLlama ✕', e.message); }
}

// ---------- ETF net flow (Farside, HTML-таблица, БЕЗ библиотек) — 30-дн. сумма колонки Total, $m→$B ----------
async function etfFlow() {
  try {
    const html = await jget('https://farside.co.uk/btc/', { timeout: 20000 });
    if (typeof html !== 'string') { log('ETF Farside ✕ не HTML'); return; }
    const dateRe = /^\s*\d{1,2}\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}/;
    const pf = s => { s = (s || '').replace(/,/g, '').trim(); if (s === '' || s === '-') return null; const neg = /^\(.*\)$/.test(s); s = s.replace(/[()]/g, ''); const n = parseFloat(s); return isFinite(n) ? (neg ? -n : n) : null; };
    const daily = [];
    for (const row of html.split(/<tr[^>]*>/i)) {
      const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => m[1].replace(/<[^>]+>/g, '').trim());
      if (cells.length < 3 || !dateRe.test(cells[0])) continue;   // только строки-даты
      const tot = pf(cells[cells.length - 1]);                     // последняя ячейка = Total
      if (tot != null) daily.push(tot);
    }
    if (daily.length) { const sum30 = daily.slice(-30).reduce((a, b) => a + b, 0); put('etfFlow', sum30 / 1000, TODAY, 'Farside 30д'); log('ETF Farside ✓', daily.length, 'дн, 30д =', (sum30 / 1000).toFixed(2), '$B'); }
    else log('ETF Farside ✕ строки не распознаны');
  } catch (e) { log('ETF Farside ✕', e.message); }
}

// ---------- TODO (Фаза C, требуют ключа/расчёта) ----------
// m2 — FRED (US+EZ+JP+UK) + Frankfurter (FX→USD), ключ FRED в Secrets.
// us10y — FRED DGS10 / Stooq CSV.  dxy — Stooq CSV.  25d-skew — Deribit book_summary → Блэк-76.
function carryTodo() {
  for (const k of ['etfFlow', 'm2', 'us10y', 'dxy']) if (!snap.metrics[k] && prevM[k]) snap.metrics[k] = prevM[k];
}

// ---------- main ----------
(async () => {
  log('=== bake', snap.asof, '===');
  await canonicalPrice();
  const bdSlugs = [...BD_CORE, ...pickRotating(Math.max(0, BD_BUDGET - BD_CORE.length))];
  log('bitcoin-data в этом прогоне:', bdSlugs.join(', '));
  await bitcoinData(bdSlugs);
  // метрики bitcoin-data, которые не тянули в этот прогон — переносим из prev
  for (const slug of BD_ROTATE) { const k = BD[slug]; if (!snap.metrics[k] && prevM[k]) snap.metrics[k] = prevM[k]; }
  await deribit();
  await others();
  await etfFlow();
  carryTodo();

  // Reserve Risk (свежий) = цена / HODL Bank — если оба есть
  const price = snap.metrics.price?.v, hb = snap.metrics.hodlBank?.v;
  if (price && hb) put('reserveRisk', price / hb, snap.metrics.hodlBank.d, '= price / HODL Bank');

  fs.writeFileSync(OUT, JSON.stringify(snap, null, 0));
  const ok = Object.values(snap.flags).filter(f => f === 'ok').length;
  log('=== готово:', ok, 'метрик ok,', Object.values(snap.flags).filter(f => f === 'anomaly').length, 'аномалий. data.json записан. ===');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
