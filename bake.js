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
const VOLATILE = new Set(['price', 'etfFlow', 'funding', 'cbPrice', 'deribitIndex', 'oiUsd', 'dvol', 'skew']); // рыночные метрики законно скачут (skew может менять знак) — отсечку аномалий к ним не применяем
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

// ---------- 25Δ option skew (Deribit book summary → Блэк-76) ----------
// >0 = коллы дороже путов (жадность/вершина); <0 = путы дороже (страх/дно). Единицы — vol points.
function normCdf(x) {                                   // Abramowitz–Stegun 7.1.26
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}
const SKEW_MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
function parseOptName(name) {                            // BTC-25JUL25-120000-C
  const m = /^BTC-(\d{1,2})([A-Z]{3})(\d{2})-(\d+)-([CP])$/.exec(name);
  if (!m || SKEW_MONTHS[m[2]] === undefined) return null;
  return { exp: Date.UTC(2000 + +m[3], SKEW_MONTHS[m[2]], +m[1], 8, 0, 0), strike: +m[4], cp: m[5] }; // экспирация 08:00 UTC
}
function ivAtDelta(pts, target) {                        // интерполяция IV по дельте; null если 25Δ вне диапазона страйков
  const arr = pts.slice().sort((a, b) => a.d - b.d);
  if (arr.length < 2 || target < arr[0].d || target > arr[arr.length - 1].d) return null;
  for (let i = 0; i < arr.length - 1; i++) {
    const a = arr[i], b = arr[i + 1];
    if (target >= a.d && target <= b.d) { const w = (b.d - a.d) ? (target - a.d) / (b.d - a.d) : 0; return a.iv + w * (b.iv - a.iv); }
  }
  return null;
}
async function deribitSkew() {
  try {
    const j = await jget('https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=option', { timeout: 20000 });
    const rows = (j && j.result) || [];
    const now = Date.now();
    const byExp = new Map();                             // экспирация -> [{strike,cp,iv,F,T}]
    for (const r of rows) {
      const p = parseOptName(r.instrument_name); if (!p) continue;
      const iv = r.mark_iv, F = r.underlying_price;      // mark_iv в процентах
      if (iv == null || !isFinite(iv) || iv <= 0 || !F) continue;
      const T = (p.exp - now) / (365 * 864e5); if (T <= 1 / 365) continue;   // отбросить <1 дня
      if (!byExp.has(p.exp)) byExp.set(p.exp, []);
      byExp.get(p.exp).push({ strike: p.strike, cp: p.cp, iv, F, T });
    }
    let best = null, bestD = 1e9;                        // цепочка, ближайшая к 30 дням
    for (const [exp, arr] of byExp) { const days = (exp - now) / 864e5, d = Math.abs(days - 30); if (arr.length >= 6 && d < bestD) { bestD = d; best = { arr, days }; } }
    if (!best) { log('Deribit skew ✕ нет подходящей цепочки'); if (prevM.skew) snap.metrics.skew = prevM.skew; return; }
    const calls = [], puts = [];
    for (const o of best.arr) {                          // Блэк-76 (r≈0): callΔ=N(d1), putΔ=N(d1)−1
      const s = o.iv / 100, sq = s * Math.sqrt(o.T);
      const d1 = (Math.log(o.F / o.strike) + 0.5 * s * s * o.T) / sq;
      const dc = normCdf(d1);
      (o.cp === 'C' ? calls : puts).push({ d: o.cp === 'C' ? dc : dc - 1, iv: o.iv });
    }
    const ivC25 = ivAtDelta(calls, 0.25), ivP25 = ivAtDelta(puts, -0.25);
    if (ivC25 == null || ivP25 == null) { log('Deribit skew ✕ нет страйков у 25Δ'); if (prevM.skew) snap.metrics.skew = prevM.skew; return; }
    const skew = +(ivC25 - ivP25).toFixed(2);
    put('skew', skew, TODAY, `Deribit 25Δ (${Math.round(best.days)}д)`);
    log('Deribit skew ✓', skew, 'vol pts @', Math.round(best.days), 'д (callIV25', ivC25.toFixed(1), '· putIV25', ivP25.toFixed(1), ')');
  } catch (e) { log('Deribit skew ✕', e.message); if (prevM.skew) snap.metrics.skew = prevM.skew; }
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

// ---------- FRED (keyless CSV, БЕЗ ключа): US10Y=DGS10, доллар=DTWEXBGS (Fed Broad), M2=M2SL ----------
// fredgraph.csv отдаётся любому клиенту (в Node CORS не действует). Формат: «дата,значение», пропуск = «.».
async function fredLast(id) {
  const t = await (await fetch('https://fred.stlouisfed.org/graph/fredgraph.csv?id=' + id)).text();
  const lines = t.trim().split('\n');
  for (let i = lines.length - 1; i >= 1; i--) {
    const p = lines[i].split(','); const v = parseFloat((p[1] || '').trim());
    if (isFinite(v)) return { date: (p[0] || '').trim(), val: v };
  }
  return null;
}
async function fred() {
  try { const y = await fredLast('DGS10');    if (y) put('us10y', y.val,       y.date, 'FRED DGS10'); }   catch (e) { log('FRED DGS10 ✕', e.message); }
  try { const d = await fredLast('DTWEXBGS'); if (d) put('dxy',   d.val,       d.date, 'FRED Broad$'); }   catch (e) { log('FRED DTWEXBGS ✕', e.message); }
  try { const m = await fredLast('M2SL');     if (m) put('m2',    m.val * 1e9, m.date, 'FRED M2SL'); }     catch (e) { log('FRED M2SL ✕', e.message); }
  log('FRED ✓');
}

// ---------- Checkonchain: LTH Net Position Change 30d (бесплатно, БЕЗ rate-лимита) ----------
// Извлекаем Plotly-данные из light.html; ноль нагрузки на bitcoin-data лимит.
function ccExtract(html) {
  const k = html.indexOf('Plotly.newPlot');
  let i = html.indexOf('[', k), depth = 0, inStr = false, esc = false, start = i;
  for (; i < html.length; i++) {
    const c = html[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) return html.slice(start, i + 1); }
  }
  return null;
}
function ccDecode(y) {
  if (!y) return null;
  if (Array.isArray(y)) return y;
  if (y.bdata) {
    const b = Buffer.from(y.bdata, 'base64');
    const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
    if (y.dtype === 'f8') return new Float64Array(ab);
    if (y.dtype === 'f4') return new Float32Array(ab);
    if (y.dtype === 'i2') return new Int16Array(ab);
    if (y.dtype === 'i4') return new Int32Array(ab);
  }
  return null;
}
async function checkonchainNpc() {
  try {
    const url = 'https://charts-cdn.checkonchain.com/btconchain/supply/lthnetposchange_0/lthnetposchange_0_light.html';
    const html = await (await fetch(url)).text();
    const data = JSON.parse(ccExtract(html));
    function ser(nm) {
      const t = data.find(t => t.name === nm);
      if (!t) return [];
      const yy = ccDecode(t.y), xx = t.x, out = [];
      for (let k = 0; k < xx.length; k++) if (isFinite(yy[k]) && yy[k] !== 0) out.push([xx[k].slice(0, 10), yy[k]]);
      return out;
    }
    const map = new Map();
    for (const [d, v] of ser('Positive 30d Change')) map.set(d, v);
    for (const [d, v] of ser('Negative 30d Change')) if (!map.has(d)) map.set(d, v);
    const dates = [...map.keys()].sort();
    if (dates.length) {
      const ld = dates[dates.length - 1];
      put('lthNpc', map.get(ld), ld, 'Checkonchain NPC 30d');
      log('Checkonchain LTH-NPC OK', (map.get(ld) / 1000).toFixed(0) + 'k @', ld);
    } else log('Checkonchain LTH-NPC пустой ряд');
  } catch (e) { log('Checkonchain LTH-NPC error', e.message); }
}

// ---------- carry-forward (если источник не ответил в этот прогон) ----------
function carryTodo() {
  for (const k of ['etfFlow', 'm2', 'us10y', 'dxy', 'skew', 'lthNpc']) if (!snap.metrics[k] && prevM[k]) snap.metrics[k] = prevM[k];
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
  await deribitSkew();
  await others();
  await etfFlow();
  await fred();
  await checkonchainNpc();
  carryTodo();

  // Reserve Risk (свежий) = цена / HODL Bank — если оба есть
  const price = snap.metrics.price?.v, hb = snap.metrics.hodlBank?.v;
  if (price && hb) put('reserveRisk', price / hb, snap.metrics.hodlBank.d, '= price / HODL Bank');

  fs.writeFileSync(OUT, JSON.stringify(snap, null, 0));
  const ok = Object.values(snap.flags).filter(f => f === 'ok').length;
  log('=== готово:', ok, 'метрик ok,', Object.values(snap.flags).filter(f => f === 'anomaly').length, 'аномалий. data.json записан. ===');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
