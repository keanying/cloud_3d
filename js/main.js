import { t, setLang, getLang, onLang, applyDom } from './i18n.js';
import { rest, GateWS, SPOT_WS, PERP_WS } from './gate.js';
import * as F from './fmt.js';
import { C, drawCandles, drawSpark, drawBars, drawBasis, drawFlow } from './charts.js';
import { createShell } from './shell3d.js';
import { createFunnel } from './funnel.js';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- config
const STABLE = new Set(['USDC', 'FDUSD', 'TUSD', 'DAI', 'USDE', 'PYUSD', 'USD1', 'BUSD', 'USDD', 'USDP', 'EUR', 'EURC',
  'EURT', 'EURI', 'GUSD', 'UST', 'USTC', 'USDJ', 'XAUT', 'PAXG', 'RLUSD', 'USDS', 'USDQ', 'USDR', 'FRAX', 'LUSD', 'SUSD',
  'USDX', 'USD0', 'USDG', 'BFUSD', 'USDF', 'USDB', 'USDTB', 'AUSD', 'SUSDE', 'CUSD', 'ZUSD', 'DUSD', 'GHO', 'CRVUSD', 'MIM']);
const LEVERAGED = /\d+[LS]$/;
const FOCUS_N = 40;     // coins on the shell (spot tickers via WS)
const TRADE_N = 16;     // coins whose spot trades are streamed
const PERP_N = 10;      // perps whose tickers + trades are streamed
const SPOT_WHALE = 10_000;
const PERP_WHALE = 50_000;
const INPUTS = [
  { kind: 'coin', sym: 'BTC_USDT', color: C.cyan },
  { kind: 'coin', sym: 'ETH_USDT', color: C.blue },
  { kind: 'coin', sym: 'SOL_USDT', color: C.violet },
  { kind: 'basis', color: C.amber },
  { kind: 'fund', color: C.green },
  { kind: 'lsr', color: C.pink },
];

// ---------------------------------------------------------------- state
const S = {
  sel: 'BTC_USDT',
  offset: 0,
  spotAll: new Map(),   // pair -> {pair, base, last, chg, qv, high, low}
  futAll: new Map(),    // contract -> {last, mark, index, funding, chg, oi, vol, q}
  focus: [],
  mk: null, fm: null,
  candles: [], book: null,
  fut: { next: 0, stats: [], fund: [] },
  tape: [], flow: [], whales: [], liqs: [], basis: [],
  whaleCount: 0, liqSeen: { long: 0, short: 0 },
  hist: new Array(60).fill(0), secTrades: 0,
  rate: new Map(), rateCur: new Map(),
  spark: new Map(),
  lat: { spot: NaN, fut: NaN },
  wire: [], frames: 0, framesPrev: 0, fps: 0,
  conn: { rest: '', spot: '', fut: '' },
  ver: { tape: 0, whales: 0, liqs: 0 },
};
let spotWS, futWS, shell, funnel, selToken = 0;
const inputs = [];

// ---------------------------------------------------------------- REST pollers
async function pollSpotAll() {
  try {
    const arr = await rest('/spot/tickers');
    S.conn.rest = 'open';
    let vol = 0, up = 0, dn = 0, n = 0, sum = 0, wsum = 0;
    const movers = [];
    for (const x of arr) {
      const pair = x.currency_pair;
      if (!pair.endsWith('_USDT')) continue;
      const b = pair.slice(0, -5), last = +x.last, qv = +x.quote_volume || 0, chg = +x.change_percentage || 0;
      const rec = S.spotAll.get(pair) || { pair, base: b };
      Object.assign(rec, { last, chg, qv, high: +x.high_24h, low: +x.low_24h });
      S.spotAll.set(pair, rec);
      if (STABLE.has(b) || LEVERAGED.test(b) || !last || !qv) continue;
      n++; vol += qv; sum += chg; wsum += chg * qv;
      if (chg > 0) up++; else if (chg < 0) dn++;
      if (qv >= 300_000) movers.push(rec);
    }
    movers.sort((a, b) => b.chg - a.chg);
    S.mk = { vol, up, dn, n, avg: sum / n, wavg: wsum / vol, gainers: movers.slice(0, 8), losers: movers.slice(-8).reverse() };
    if (S.focus.length) shell && shell.setClusters(clusterList());
  } catch (e) {
    S.conn.rest = 'closed';
  }
}

async function pollFutAll() {
  try {
    const arr = await rest('/futures/usdt/tickers');
    S.conn.rest = 'open';
    let oi = 0, vol = 0, fw = 0;
    for (const x of arr) {
      const q = +x.quanto_multiplier || 0, mark = +x.mark_price;
      const rec = S.futAll.get(x.contract) || { contract: x.contract };
      Object.assign(rec, {
        q, last: +x.last, mark, index: +x.index_price, funding: +x.funding_rate,
        chg: +x.change_percentage, size: +x.total_size, oi: (+x.total_size) * q * mark, vol: +x.volume_24h_quote || 0,
      });
      S.futAll.set(x.contract, rec);
      if (Number.isFinite(rec.oi)) { oi += rec.oi; fw += rec.funding * rec.oi; }
      vol += rec.vol;
    }
    S.fm = { oi, vol, funding: oi ? fw / oi : NaN, n: arr.length };
  } catch (e) {
    S.conn.rest = 'closed';
  }
}

async function pollSelPerp(token) {
  const sym = S.sel;
  if (!S.futAll.has(sym)) return;
  try {
    const [stats, contract] = await Promise.all([
      rest('/futures/usdt/contract_stats', { contract: sym, interval: '5m', limit: 24 }),
      rest('/futures/usdt/contracts/' + sym),
    ]);
    if (token !== selToken) return;
    S.fut.stats = stats.sort((a, b) => a.time - b.time);
    S.fut.next = +contract.funding_next_apply || 0;
  } catch (e) { /* keep previous */ }
}

async function pollFunding(token) {
  const sym = S.sel;
  if (!S.futAll.has(sym)) return;
  try {
    const arr = await rest('/futures/usdt/funding_rate', { contract: sym, limit: 30 });
    if (token !== selToken) return;
    S.fut.fund = arr.map((x) => ({ t: x.t, r: +x.r })).sort((a, b) => a.t - b.t);
  } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------- focus / shell
function computeFocus() {
  const list = [...S.spotAll.values()]
    .filter((r) => !STABLE.has(r.base) && !LEVERAGED.test(r.base) && r.qv > 0 && r.last > 0)
    .sort((a, b) => b.qv - a.qv)
    .map((r) => r.pair);
  const focus = list.slice(0, FOCUS_N);
  for (const c of INPUTS) if (c.sym && S.spotAll.has(c.sym) && !focus.includes(c.sym)) focus.splice(focus.length - 1, 1, c.sym);
  S.focus = focus;
}

function clusterList() {
  const recs = S.focus.map((p) => S.spotAll.get(p)).filter(Boolean);
  const lv = recs.map((r) => Math.log10(Math.max(1, r.qv)));
  const lo = Math.min(...lv), hi = Math.max(...lv);
  return recs.map((r, i) => ({ sym: r.pair, chg: r.chg, last: r.last, qv: r.qv, volNorm: hi > lo ? (lv[i] - lo) / (hi - lo) : 1 }));
}

// ---------------------------------------------------------------- websockets
function connectWS() {
  spotWS = new GateWS(SPOT_WS, 'spot', { onMessage: onSpot, onStatus: (s) => { S.conn.spot = s; sysWire('spot', s); } });
  futWS = new GateWS(PERP_WS, 'futures', { onMessage: onFut, onStatus: (s) => { S.conn.fut = s; sysWire('fut', s); } });
  S.focus.forEach((p) => spotWS.subscribe('spot.tickers', [p]));
  S.focus.slice(0, TRADE_N).forEach((p) => spotWS.subscribe('spot.trades', [p]));
  S.focus.filter((p) => S.futAll.has(p)).slice(0, PERP_N).forEach((p) => {
    futWS.subscribe('futures.tickers', [p]);
    futWS.subscribe('futures.trades', [p]);
  });
  futWS.subscribe('futures.public_liquidates', ['!all']);
  spotWS.connect();
  futWS.connect();
}

function selSubs(sym, on) {
  const fn = on ? 'subscribe' : 'unsubscribe';
  spotWS[fn]('spot.tickers', [sym]);
  spotWS[fn]('spot.trades', [sym]);
  spotWS[fn]('spot.order_book', [sym, '20', '100ms']);
  spotWS[fn]('spot.candlesticks', ['1m', sym]);
  if (S.futAll.has(sym)) {
    futWS[fn]('futures.tickers', [sym]);
    futWS[fn]('futures.trades', [sym]);
  }
}

async function selectSymbol(sym) {
  if (!sym || !S.spotAll.has(sym)) return;
  if (spotWS && S.sel && S.sel !== sym) selSubs(S.sel, false);
  const changed = S.sel !== sym || !S.candles.length;
  S.sel = sym;
  const token = ++selToken;
  if (changed) {
    S.candles = []; S.book = null; S.tape = []; S.flow = []; S.basis = [];
    S.fut = { next: 0, stats: [], fund: [] };
    S.ver.tape++;
  }
  selSubs(sym, true);
  document.querySelectorAll('.sym-name').forEach((el) => { el.textContent = F.base(sym); });
  const sel = $('sym-select');
  if (sel.value !== sym) {
    if (![...sel.options].some((o) => o.value === sym)) sel.add(new Option(F.base(sym), sym));
    sel.value = sym;
  }
  shell && shell.setSelected(sym);
  try {
    const raw = await rest('/spot/candlesticks', { currency_pair: sym, interval: '1m', limit: 120 });
    if (token !== selToken) return;
    const fromRest = raw.map((a) => ({ t: +a[0], v: +a[1], c: +a[2], h: +a[3], l: +a[4], o: +a[5] }));
    // keep any live candle that arrived over WS while REST was in flight
    const live = S.candles.filter((k) => k.t > fromRest[fromRest.length - 1].t);
    S.candles = fromRest.concat(live);
  } catch (e) { /* WS will fill in */ }
  pollSelPerp(token);
  pollFunding(token);
}

// Push latency = local receive time (server-clock corrected) − server push time.
// Only trade / book channels are used: Gate batches ticker pushes (~0.5 s).
const LAT_CH = /\.(trades|order_book|book_ticker)$/;
const latBuf = { spot: [], fut: [] };
function latency(kind, m) {
  if (!m.time_ms || m.event !== 'update' || !LAT_CH.test(m.channel)) return;
  const b = latBuf[kind];
  b.push(Date.now() + S.offset - m.time_ms);
  if (b.length > 61) b.shift();
  const sorted = b.slice().sort((x, y) => x - y);
  S.lat[kind] = sorted[sorted.length >> 1];
}

function onSpot(m) {
  S.frames++;
  latency('spot', m);
  wireLog('spot', m);
  const r = m.result;
  if (m.event !== 'update' || !r) return;
  switch (m.channel) {
    case 'spot.tickers': {
      const rec = S.spotAll.get(r.currency_pair);
      if (!rec) return;
      Object.assign(rec, { last: +r.last, chg: +r.change_percentage, qv: +r.quote_volume, high: +r.high_24h, low: +r.low_24h });
      shell && shell.updateTicker(r.currency_pair, rec.chg, rec.last);
      break;
    }
    case 'spot.trades':
      onTrade('spot', r.currency_pair, r.side, +r.price, +r.amount, +r.create_time_ms);
      break;
    case 'spot.order_book':
      if (r.s === S.sel) S.book = { bids: r.bids.map((x) => [+x[0], +x[1]]), asks: r.asks.map((x) => [+x[0], +x[1]]) };
      break;
    case 'spot.candlesticks': {
      const pair = r.n.slice(r.n.indexOf('_') + 1);
      if (pair !== S.sel) return;
      const k = { t: +r.t, o: +r.o, h: +r.h, l: +r.l, c: +r.c, v: +r.v };
      const lastK = S.candles[S.candles.length - 1];
      if (lastK && lastK.t === k.t) S.candles[S.candles.length - 1] = k;
      else if (!lastK || k.t > lastK.t) { S.candles.push(k); if (S.candles.length > 240) S.candles.shift(); }
      break;
    }
  }
}

function onFut(m) {
  S.frames++;
  latency('fut', m);
  wireLog('fut', m);
  const arr = m.result;
  if (m.event !== 'update' || !Array.isArray(arr)) return;
  switch (m.channel) {
    case 'futures.tickers':
      for (const x of arr) {
        const rec = S.futAll.get(x.contract) || { contract: x.contract, q: 0 };
        if (x.last) rec.last = +x.last;
        if (x.mark_price) rec.mark = +x.mark_price;
        if (x.index_price) rec.index = +x.index_price;
        if (x.funding_rate) rec.funding = +x.funding_rate;
        if (x.change_percentage) rec.chg = +x.change_percentage;
        if (x.total_size && rec.q) rec.oi = +x.total_size * rec.q * (rec.mark || rec.last);
        S.futAll.set(x.contract, rec);
      }
      break;
    case 'futures.trades':
      for (const x of arr) {
        const q = S.futAll.get(x.contract)?.q || 0, size = +x.size;
        if (!q) continue;
        onTrade('perp', x.contract, size > 0 ? 'buy' : 'sell', +x.price, Math.abs(size) * q, +x.create_time_ms);
      }
      break;
    case 'futures.public_liquidates':
      for (const x of arr) {
        const q = S.futAll.get(x.contract)?.q || 0, size = +x.size, px = +x.price;
        const notional = Math.abs(size) * q * px;
        if (!notional) continue;
        // a negative order size is a forced sell, i.e. a long position being liquidated
        const side = size < 0 ? 'long' : 'short';
        S.liqSeen[side] += notional;
        S.liqs.unshift({ ts: +x.time, pair: x.contract, side, px, notional });
        if (S.liqs.length > 8) S.liqs.length = 8;
        S.ver.liqs++;
        if (x.contract === S.sel) funnel && funnel.liq(px, notional, side);
        shell && shell.pulse(x.contract, Math.min(1.2, 0.3 + Math.log10(Math.max(1, notional)) / 8));
      }
      break;
  }
}

function onTrade(mkt, pair, side, price, amount, ts) {
  const notional = price * amount;
  if (!Number.isFinite(notional)) return;
  S.secTrades++;
  S.rateCur.set(pair, (S.rateCur.get(pair) || 0) + 1);
  if (pair === S.sel) {
    S.tape.unshift({ ts, mkt, side, price, amount, notional });
    if (S.tape.length > 40) S.tape.length = 40;
    S.flow.push({ ts: Date.now(), side, notional });
    S.ver.tape++;
  }
  // Gate reports every maker fill separately; fills of one taker order share
  // symbol, side and timestamp, so merge them before testing the whale threshold.
  const key = mkt + '|' + pair + '|' + side + '|' + Math.floor(ts);
  const agg = pending.get(key);
  if (agg) { agg.notional += notional; agg.amount += amount; agg.price = price; }
  else pending.set(key, { mkt, pair, side, price, amount, notional, ts });
  shell && shell.pulse(pair, Math.min(0.25, 0.03 + (notional / (mkt === 'spot' ? SPOT_WHALE : PERP_WHALE)) * 0.3));
}

const pending = new Map();
function flushOrders() {
  for (const o of pending.values()) {
    const th = o.mkt === 'spot' ? SPOT_WHALE : PERP_WHALE;
    if (o.notional < th) continue;
    S.whaleCount++;
    S.whales.unshift({ id: S.whaleCount, ...o, th });
    if (S.whales.length > 14) S.whales.length = 14;
    S.ver.whales++;
    shell && shell.pulse(o.pair, Math.min(1.4, 0.6 + Math.log10(o.notional / th)));
  }
  pending.clear();
}

// ---------------------------------------------------------------- wire inspector
function sysWire(kind, status) {
  pushWire({ ts: Date.now(), cls: 'ch-sys', ch: kind === 'spot' ? 'spot.ws' : 'futures.ws', txt: status });
}
function pushWire(e) {
  S.wire.unshift(e);
  if (S.wire.length > 30) S.wire.length = 30;
}
function wireLog(kind, m) {
  const ch = m.channel || '';
  const r = m.result;
  let txt = '', cls = kind === 'spot' ? 'ch-spot' : 'ch-fut', hl = false;
  if (m.event === 'subscribe' || m.event === 'unsubscribe') txt = `${m.event} ${JSON.stringify(m.payload || '')} → ${r?.status || m.error?.message || ''}`;
  else if (ch.endsWith('.pong')) txt = 'pong';
  else if (m.event !== 'update' || !r) return;
  else if (ch === 'spot.trades') txt = `${r.currency_pair} ${r.side.toUpperCase()} ${r.amount} @ ${r.price}`;
  else if (ch === 'spot.tickers') txt = `${r.currency_pair} ${r.last} ${F.pct(+r.change_percentage)}`;
  else if (ch === 'spot.order_book') txt = `${r.s} bid ${r.bids[0]?.[0]} / ask ${r.asks[0]?.[0]} · L${r.bids.length}`;
  else if (ch === 'spot.candlesticks') txt = `${r.n} o${r.o} h${r.h} l${r.l} c${r.c}`;
  else if (ch === 'futures.trades') { const x = r[0]; txt = `${x.contract} ${x.size > 0 ? 'BUY' : 'SELL'} ${Math.abs(x.size)}c @ ${x.price}`; }
  else if (ch === 'futures.tickers') { const x = r[0]; txt = `${x.contract} mark ${x.mark_price} fr ${x.funding_rate}`; }
  else if (ch === 'futures.public_liquidates') { const x = r[0]; txt = `${x.contract} LIQ ${x.size} @ ${x.price}`; cls = 'ch-liq'; hl = true; }
  else txt = JSON.stringify(r).slice(0, 80);
  pushWire({ ts: m.time_ms || Date.now(), cls, ch, txt, hl });
}

// ---------------------------------------------------------------- per-second sampling
function perSecond() {
  S.hist.push(S.secTrades); S.hist.shift(); S.secTrades = 0;
  S.rate = S.rateCur; S.rateCur = new Map();
  S.fps = S.frames - S.framesPrev; S.framesPrev = S.frames;
  for (const c of INPUTS) {
    if (!c.sym) continue;
    const rec = S.spotAll.get(c.sym);
    if (!rec) continue;
    const arr = S.spark.get(c.sym) || [];
    arr.push(rec.last); if (arr.length > 90) arr.shift();
    S.spark.set(c.sym, arr);
  }
  const sp = S.spotAll.get(S.sel)?.last, fu = S.futAll.get(S.sel);
  if (sp) {
    S.basis.push({
      bps: fu && fu.last ? ((fu.last - sp) / sp) * 1e4 : NaN,
      prem: fu && fu.index ? ((fu.mark - fu.index) / fu.index) * 1e4 : NaN,
      latS: S.lat.spot, latF: S.lat.fut,
    });
    if (S.basis.length > 150) S.basis.shift();
  }
  const cut = Date.now() - 60000;
  while (S.flow.length && S.flow[0].ts < cut) S.flow.shift();
  $('clock').textContent = F.hms(Date.now() + S.offset) + ' UTC';
}

// ---------------------------------------------------------------- rendering
function setText(id, txt, cl) {
  const el = $(id);
  if (!el) return;
  if (el.textContent !== txt) el.textContent = txt;
  if (cl !== undefined) { el.classList.toggle('up', cl === 'up'); el.classList.toggle('dn', cl === 'dn'); }
}

function buildInputs() {
  const box = $('inputs');
  box.innerHTML = '';
  inputs.length = 0;
  for (const c of INPUTS) {
    const el = document.createElement('div');
    el.className = 'icard';
    el.style.setProperty('--c', c.color);
    el.innerHTML = '<div class="ic-h"><span class="ic-t"></span><span class="ic-v">—</span></div><div class="ic-s">—</div><canvas></canvas>';
    el.addEventListener('click', () => c.sym && selectSymbol(c.sym));
    box.appendChild(el);
    inputs.push({ ...c, el, tEl: el.querySelector('.ic-t'), vEl: el.querySelector('.ic-v'), sEl: el.querySelector('.ic-s'), cv: el.querySelector('canvas') });
  }
}

function renderInputs() {
  const sym = S.sel, fu = S.futAll.get(sym), b = F.base(sym);
  for (const c of inputs) {
    let title = '', val = '—', sub = '—', series = [], vcl = '', zero = false;
    if (c.kind === 'coin') {
      const rec = S.spotAll.get(c.sym);
      title = F.base(c.sym);
      if (rec) { val = F.price(rec.last); sub = t('in.spot', { chg: F.pct(rec.chg) }); vcl = F.cls(rec.chg); }
      series = S.spark.get(c.sym) || [];
    } else if (c.kind === 'basis') {
      title = t('in.basis');
      const lastB = S.basis[S.basis.length - 1];
      if (lastB && Number.isFinite(lastB.bps)) { val = F.bps(lastB.bps); vcl = F.cls(lastB.bps); }
      sub = fu ? t('in.basis.s', { sym: b }) : t('fn.nofut');
      series = S.basis.map((x) => x.bps); zero = true;
    } else if (c.kind === 'fund') {
      title = t('in.fund');
      if (fu && Number.isFinite(fu.funding)) { val = (fu.funding * 100).toFixed(4) + '%'; vcl = F.cls(fu.funding); }
      sub = fu ? t('in.fund.s', { sym: b, n: S.fut.fund.length }) : t('fn.nofut');
      series = S.fut.fund.map((x) => x.r); zero = true;
    } else if (c.kind === 'lsr') {
      title = t('in.lsr');
      const st = S.fut.stats[S.fut.stats.length - 1];
      if (st) { val = (+st.lsr_account).toFixed(2); vcl = st.lsr_account >= 1 ? 'up' : 'dn'; }
      sub = fu ? t('in.lsr.s', { sym: b }) : t('fn.nofut');
      series = S.fut.stats.map((x) => +x.lsr_account);
    }
    if (c.tEl.textContent !== title) c.tEl.textContent = title;
    if (c.vEl.textContent !== val) c.vEl.textContent = val;
    c.vEl.className = 'ic-v ' + vcl;
    if (c.sEl.textContent !== sub) c.sEl.textContent = sub;
    drawSpark(c.cv, series, c.color, { zero });
  }
}

function renderHeader() {
  const rec = S.spotAll.get(S.sel);
  setText('h-sym', F.base(S.sel));
  setText('h-price', rec ? F.price(rec.last) : '—');
  setText('h-chg', rec ? F.pct(rec.chg) : '—', rec ? F.cls(rec.chg) : '');
  if (S.mk) {
    const br = (S.mk.up / Math.max(1, S.mk.up + S.mk.dn)) * 100;
    setText('h-breadth', br.toFixed(1) + '%', br >= 50 ? 'up' : 'dn');
    setText('h-vol', F.usd(S.mk.vol));
  }
  if (S.fm) setText('h-oi', F.usd(S.fm.oi));
  for (const k of ['rest', 'spot', 'fut']) $('c-' + k).className = S.conn[k] || '';
}

function renderOverview() {
  const mk = S.mk, fm = S.fm;
  if (mk) {
    setText('ov-vol', F.usd(mk.vol));
    setText('ov-sub', t('ov.sub', { n: mk.n, avg: F.pct(mk.avg), wavg: F.pct(mk.wavg) }));
    const tot = Math.max(1, mk.up + mk.dn);
    $('ov-bar-up').style.width = (mk.up / tot) * 100 + '%';
    $('ov-bar-dn').style.width = (mk.dn / tot) * 100 + '%';
    setText('ov-up', String(mk.up));
    setText('ov-dn', String(mk.dn));
    const br = (mk.up / tot) * 100;
    setText('ov-breadth', br.toFixed(1) + '%', br >= 50 ? 'up' : 'dn');
    const g = mk.gainers[0], l = mk.losers[0];
    setText('ov-gainer', g ? `${g.base} ${F.pct(g.chg)}` : '—');
    setText('ov-loser', l ? `${l.base} ${F.pct(l.chg)}` : '—');
  }
  if (fm) {
    setText('ov-oi', F.usd(fm.oi));
    setText('ov-pvol', F.usd(fm.vol));
    setText('ov-fund', Number.isFinite(fm.funding) ? (fm.funding * 100).toFixed(4) + '%' : '—', F.cls(fm.funding));
  }
}

function renderBook() {
  const bk = S.book;
  if (!bk || !bk.bids.length || !bk.asks.length) return;
  const ba = bk.asks[0][0], bb = bk.bids[0][0], spread = ba - bb, mid = (ba + bb) / 2;
  setText('ld-spread', t('ld.spread', { v: F.price(spread, F.priceDigits(mid)) }));
  // ladder: 5 / 5
  const a5 = bk.asks.slice(0, 5).reverse(), b5 = bk.bids.slice(0, 5);
  const m5 = Math.max(...a5.map((x) => x[1]), ...b5.map((x) => x[1]));
  const row = (x, c, m) => `<div class="lr ${c}"><i style="width:${((x[1] / m) * 100).toFixed(1)}%"></i><span>${F.price(x[0])}</span><span>${F.amt(x[1])}</span></div>`;
  $('ladder').innerHTML = a5.map((x) => row(x, 'a', m5)).join('') + `<div class="mid">${F.price(mid)}</div>` + b5.map((x) => row(x, 'b', m5)).join('');
  // depth: 8 / 8 with cumulative
  const cum = (arr) => { let s = 0; return arr.map((x) => [x[0], x[1], (s += x[1])]); };
  const asks = cum(bk.asks.slice(0, 8)), bids = cum(bk.bids.slice(0, 8));
  const mc = Math.max(asks[asks.length - 1][2], bids[bids.length - 1][2]);
  const drow = (x, c) => `<div class="drow ${c}"><i style="width:${((x[2] / mc) * 100).toFixed(1)}%"></i><span>${F.price(x[0])}</span><span>${F.amt(x[1])}</span><span>${F.amt(x[2])}</span></div>`;
  $('depth-asks').innerHTML = asks.slice().reverse().map((x) => drow(x, 'a')).join('');
  $('depth-bids').innerHTML = bids.map((x) => drow(x, 'b')).join('');
  setText('depth-spread', t('dp.spread', { v: F.price(spread, F.priceDigits(mid)), bps: ((spread / mid) * 1e4).toFixed(2) }));
}

function renderSpot() {
  const rec = S.spotAll.get(S.sel);
  if (rec) {
    setText('sp-price', F.price(rec.last), F.cls(rec.chg));
    setText('sp-chg', F.pct(rec.chg), F.cls(rec.chg));
    setText('sp-high', F.price(rec.high));
    setText('sp-low', F.price(rec.low));
    setText('sp-qv', F.usd(rec.qv));
  }
  drawCandles($('cv-candles'), S.candles);
  drawSpark($('cv-ld'), S.candles.slice(-40).map((k) => k.c), rec && rec.chg < 0 ? C.red : C.green);
}

function renderBasis() {
  const fu = S.futAll.get(S.sel), lb = S.basis[S.basis.length - 1];
  setText('bs-lat-s', Number.isFinite(S.lat.spot) ? Math.round(S.lat.spot) + ' ms' : '—');
  setText('bs-lat-f', Number.isFinite(S.lat.fut) ? Math.round(S.lat.fut) + ' ms' : '—');
  setText('bs-basis', lb && Number.isFinite(lb.bps) ? F.bps(lb.bps) + ' bp' : '—', lb ? F.cls(lb.bps) : '');
  setText('bs-prem', lb && Number.isFinite(lb.prem) ? F.bps(lb.prem) + ' bp' : '—', lb ? F.cls(lb.prem) : '');
  setText('bs-mark', fu && fu.mark ? F.price(fu.mark) : '—');
  setText('bs-index', fu && fu.index ? F.price(fu.index) : '—');
  drawBasis($('cv-basis'), S.basis, { basis: t('bs.legend.basis'), prem: t('bs.legend.prem'), lat: t('bs.legend.lat') });
}

function renderWire() {
  $('wire').innerHTML = S.wire.slice(0, 13).map((e) =>
    `<div class="wr${e.hl ? ' hl' : ''}"><span class="ts">${F.hmsms(e.ts)}</span><span class="${e.cls}">${F.esc(e.ch)}</span><span>${F.esc(e.txt)}</span></div>`).join('');
  setText('wi-rate', S.fps + ' msg/s');
  setText('wi-total', F.num(S.frames));
  setText('wi-bytes', F.bytes((spotWS?.bytes || 0) + (futWS?.bytes || 0)));
  setText('wi-subs', String((spotWS?.subs.size || 0) + (futWS?.subs.size || 0)));
}

let whalesVer = -1;
function renderWhales() {
  setText('wh-th', t('wh.th', { s: F.usd(SPOT_WHALE, 0), p: F.usd(PERP_WHALE, 0) }));
  setText('hist-now', S.hist[S.hist.length - 1] + '/s');
  drawBars($('cv-hist'), S.hist, C.amber);
  if (whalesVer === S.ver.whales) return;
  const box = $('whales');
  const known = new Set([...box.children].map((el) => el.dataset.id));
  if (!S.whales.length) { box.innerHTML = `<div class="wc-s">${F.esc(t('wh.empty'))}</div>`; whalesVer = S.ver.whales; return; }
  if (box.firstElementChild && !box.firstElementChild.dataset.id) box.innerHTML = '';
  // prepend new ones (oldest first so the newest ends on top)
  for (const w of S.whales.slice().reverse()) {
    if (known.has(String(w.id))) continue;
    const el = document.createElement('div');
    el.className = 'wcard ' + w.side;
    el.dataset.id = w.id;
    el.dataset.pair = w.pair;
    el.innerHTML = `<div class="wc-h"><b>${F.esc(F.base(w.pair))}</b><span class="${w.side === 'buy' ? 'up' : 'dn'}">${F.esc(t(w.side === 'buy' ? 'wh.buy' : 'wh.sell'))} · ${F.esc(t(w.mkt))}</span><em>${F.usd(w.notional)}</em></div>` +
      `<div class="wc-s">@ ${F.price(w.price)} · ${F.hms(w.ts)}</div><div class="wc-bar"><i style="width:${Math.min(100, (Math.log10(w.notional / w.th) + 0.15) * 80).toFixed(0)}%"></i></div>`;
    el.addEventListener('click', () => selectSymbol(w.pair));
    box.prepend(el);
    shell && shell.link(w.pair, el);
  }
  while (box.children.length > 14) box.lastElementChild.remove();
  whalesVer = S.ver.whales;
}

let tapeVer = -1;
function renderTape() {
  if (tapeVer !== S.ver.tape) {
    tapeVer = S.ver.tape;
    $('tape-body').innerHTML = S.tape.slice(0, 30).map((x) => {
      const th = x.mkt === 'spot' ? SPOT_WHALE : PERP_WHALE;
      const sc = x.side === 'buy' ? 'up' : 'dn';
      return `<tr class="${x.notional >= th ? 'big' : ''}"><td>${F.hms(x.ts)}</td><td class="m-${x.mkt}">${F.esc(t(x.mkt))}</td>` +
        `<td class="${sc}">${F.esc(t(x.side === 'buy' ? 'wh.buy' : 'wh.sell'))}</td><td class="${sc}">${F.price(x.price)}</td><td>${F.amt(x.amount)}</td><td>${F.usd(x.notional)}</td></tr>`;
    }).join('');
  }
  const now = Date.now(), buckets = Array.from({ length: 12 }, () => ({ buy: 0, sell: 0 }));
  let buy = 0, sell = 0;
  for (const f of S.flow) {
    const i = 11 - Math.floor((now - f.ts) / 5000);
    if (i < 0 || i > 11) continue;
    buckets[i][f.side] += f.notional;
    if (f.side === 'buy') buy += f.notional; else sell += f.notional;
  }
  drawFlow($('cv-flow'), buckets);
  setText('fl-buy', '▲ ' + F.usd(buy));
  setText('fl-sell', '▼ ' + F.usd(sell));
  const lt = S.tape[0];
  setText('tc-last', lt ? `${F.price(lt.price)}` : '—', lt ? (lt.side === 'buy' ? 'up' : 'dn') : '');
  setText('tc-buy', buy + sell ? ((buy / (buy + sell)) * 100).toFixed(1) + '%' : '—', buy + sell ? (buy >= sell ? 'up' : 'dn') : '');
  setText('tc-vol', F.usd(buy + sell));
  setText('tc-whales', String(S.whaleCount));
}

function sigma1m() {
  const cs = S.candles.slice(-61);
  if (cs.length < 10) return NaN;
  const r = [];
  for (let i = 1; i < cs.length; i++) r.push(Math.log(cs[i].c / cs[i - 1].c));
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  return Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1));
}

let liqVer = -1;
function renderFunnelPanel() {
  const fu = S.futAll.get(S.sel), now = Date.now() + S.offset;
  if (fu && S.fut.next) {
    setText('fc-fund', F.dur(S.fut.next - now / 1000));
    setText('fc-fund-r', (fu.funding * 100).toFixed(4) + '%', F.cls(fu.funding));
  } else {
    setText('fc-fund', '—');
    setText('fc-fund-r', fu ? '—' : t('fn.nofut'), '');
  }
  const sg = sigma1m();
  setText('fc-vol', Number.isFinite(sg) ? (sg * Math.sqrt(525600) * 100).toFixed(1) + '%' : '—');
  const st = S.fut.stats[S.fut.stats.length - 1];
  if (st) {
    setText('fc-lsr', (+st.lsr_account).toFixed(2), st.lsr_account >= 1 ? 'up' : 'dn');
    setText('fc-lsr-s', `L ${F.num(st.long_users)} / S ${F.num(st.short_users)}`);
    let l = 0, s = 0;
    for (const x of S.fut.stats) { l += +x.long_liq_usd || 0; s += +x.short_liq_usd || 0; }
    setText('fc-liq', F.usd(l + s));
    setText('fc-liq-s', t('fn.liq.split', { l: F.usd(l), s: F.usd(s) }));
  } else {
    for (const id of ['fc-lsr', 'fc-liq']) setText(id, '—', '');
    for (const id of ['fc-lsr-s', 'fc-liq-s']) setText(id, fu ? '—' : t('fn.nofut'));
  }
  if (liqVer !== S.ver.liqs) {
    liqVer = S.ver.liqs;
    $('liq-list').innerHTML = `<div class="lh">${F.esc(t('fn.liq.head'))}</div>` + S.liqs.slice(0, 5).map((x) =>
      `<div class="lq"><span class="${x.side === 'long' ? 'dn' : 'up'}">${F.esc(F.base(x.pair))} ${F.esc(t(x.side === 'long' ? 'fn.liq.long' : 'fn.liq.short'))}</span> <em>${F.usd(x.notional)}</em> @ ${F.price(x.px)}</div>`).join('');
  }
}

function renderMarquees() {
  const mk = S.mk, fm = S.fm;
  if (!mk) return;
  const it = (r) => `<span class="it">${F.esc(r.base)} <b>${F.price(r.last)}</b><span class="${F.cls(r.chg)}">${F.pct(r.chg)}</span></span>`;
  const majors = S.focus.slice(0, 12).map((p) => S.spotAll.get(p)).filter(Boolean);
  $('mq-top').innerHTML = majors.map(it).join('') +
    `<span class="it ch-sys">${F.esc(t('mq.gain'))} ▲</span>` + mk.gainers.map(it).join('') +
    `<span class="it ch-sys">${F.esc(t('mq.lose'))} ▼</span>` + mk.losers.map(it).join('');
  $('mq-bottom').innerHTML = `<span class="it">${F.esc(t('mq.summary', {
    n: mk.n, up: mk.up, dn: mk.dn, vol: F.usd(mk.vol), oi: fm ? F.usd(fm.oi) : '—', pvol: fm ? F.usd(fm.vol) : '—',
    fund: fm && Number.isFinite(fm.funding) ? (fm.funding * 100).toFixed(4) + '%' : '—',
    liq: F.usd(S.liqSeen.long + S.liqSeen.short), wh: S.whaleCount,
  }))}</span>`;
}

function buildSelect() {
  const sel = $('sym-select');
  sel.innerHTML = '';
  for (const p of S.focus) sel.add(new Option(F.base(p), p));
  sel.value = S.sel;
  sel.onchange = () => selectSymbol(sel.value);
}

function render() {
  renderHeader();
  renderOverview();
  renderBook();
  renderSpot();
  renderBasis();
  renderWire();
  renderInputs();
  renderWhales();
  renderTape();
  renderFunnelPanel();
  setText('sh-count', t('sh.count', { n: shell ? shell.count() : 0 }));
  $('shell-wait').classList.toggle('hide', !!(shell && shell.count()));
}

// ---------------------------------------------------------------- tooltip
function onHover(sym, x, y) {
  const tip = $('shell-tip');
  if (!sym) { tip.style.display = 'none'; return; }
  const r = S.spotAll.get(sym), fu = S.futAll.get(sym);
  if (!r) return;
  tip.innerHTML = `<div class="tt-h">${F.esc(r.base)} / USDT</div>` +
    `<div class="tt-r"><span>${F.esc(t('sh.tip.price'))}</span><b>${F.price(r.last)}</b></div>` +
    `<div class="tt-r"><span>${F.esc(t('sh.tip.chg'))}</span><b class="${F.cls(r.chg)}">${F.pct(r.chg)}</b></div>` +
    `<div class="tt-r"><span>${F.esc(t('sh.tip.vol'))}</span><b>${F.usd(r.qv)}</b></div>` +
    (fu ? `<div class="tt-r"><span>${F.esc(t('sh.tip.perp'))}</span><b class="${F.cls(fu.funding)}">${(fu.funding * 100).toFixed(4)}%</b></div>` : '');
  tip.style.display = 'block';
  const wrap = $('shell-wrap');
  tip.style.left = Math.min(x + 14, wrap.clientWidth - tip.offsetWidth - 6) + 'px';
  tip.style.top = Math.min(y + 14, wrap.clientHeight - tip.offsetHeight - 6) + 'px';
}

// ---------------------------------------------------------------- main loop
function loop(now) {
  if (shell) {
    const wires = inputs.map((c) => {
      const sym = c.sym || S.sel;
      return { el: c.el, sym, color: c.color, activity: Math.min(1, (S.rate.get(sym) || 0) / 25) };
    });
    shell.frame(now, wires);
  }
  if (funnel) {
    const cs = S.candles.slice(-60);
    funnel.draw(now, {
      closes: cs.map((k) => ({ t: k.t, c: k.c })),
      last: S.spotAll.get(S.sel)?.last,
      sigma1m: sigma1m(),
      labels: { now: t('fn.now'), wait: t('fn.wait') },
    });
  }
  requestAnimationFrame(loop);
}

// ---------------------------------------------------------------- boot
async function boot() {
  applyDom();
  $('lang-btn').addEventListener('click', () => setLang(getLang() === 'zh' ? 'en' : 'zh'));
  onLang(() => { whalesVer = -1; tapeVer = -1; liqVer = -1; $('whales').innerHTML = ''; render(); renderMarquees(); });
  buildInputs();
  funnel = createFunnel($('cv-funnel'));
  try {
    shell = createShell($('shell-wrap'), { onPick: selectSymbol, onHover });
  } catch (e) {
    console.error('WebGL shell unavailable', e);
    shell = null;
  }
  requestAnimationFrame(loop);
  setInterval(perSecond, 1000);
  setInterval(flushOrders, 250);
  setInterval(render, 250);

  try {
    const t0 = Date.now(), r = await rest('/spot/time'), t1 = Date.now();
    const raw = r.server_time - (t0 + t1) / 2;
    // only correct the local clock when it is clearly off; the round trip is too noisy otherwise
    S.offset = Math.abs(raw) > (t1 - t0) ? raw : 0;
  } catch (e) { /* use local clock */ }

  // retry until the first market snapshot is in
  while (!S.spotAll.size) {
    await Promise.all([pollSpotAll(), pollFutAll()]);
    if (!S.spotAll.size) await new Promise((res) => setTimeout(res, 5000));
  }
  computeFocus();
  buildSelect();
  shell && shell.setClusters(clusterList());
  sh_note();
  connectWS();
  await selectSymbol(S.sel);
  renderMarquees();

  setInterval(pollSpotAll, 15000);
  setInterval(pollFutAll, 30000);
  setInterval(() => pollSelPerp(selToken), 60000);
  setInterval(() => pollFunding(selToken), 300000);
  setInterval(renderMarquees, 45000);
}

function sh_note() {
  const el = document.querySelector('.ph-note');
  const upd = () => { el.textContent = t('sh.note', { n: S.focus.length }); };
  upd();
  onLang(upd);
}

boot();
