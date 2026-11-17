// The bets & P&L chart page.
//
// `ev-placer bets` (the "Show bets" launcher) writes bets.html next to the app and opens
// it in your browser through a small local server (127.0.0.1 only), so the page can also
// save results you mark on it to results.json. Closing the window stops the server; the
// bets.html file still opens on its own afterwards (read-only).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadBets, makeResults } from './results.js';
import { BOOK_LABELS } from './books/index.js';

export function reportData(dir, { dryRun = false } = {}) {
  return { generatedAt: new Date().toISOString(), dryRun, books: BOOK_LABELS, bets: loadBets(dir, { dryRun }) };
}

export function renderPage(data, { live = false } = {}) {
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return PAGE.replace('__DATA__', json).replace('__LIVE__', live ? 'true' : 'false');
}

export function writeSnapshot(dir, opts) {
  const file = path.join(dir, opts?.dryRun ? 'bets.dry.html' : 'bets.html');
  fs.writeFileSync(file, renderPage(reportData(dir, opts)));
  return file;
}

export function openInBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? ['explorer.exe', [url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref(); } catch {}
}

/** Serve the page on 127.0.0.1. Resolves with the URL once listening. */
export function serveReport(dir, { dryRun = false, port = 8766, log } = {}) {
  const results = makeResults(dir, { dryRun });
  const server = http.createServer((req, res) => {
    const send = (code, type, body) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
    // Only this machine's browser, and only same-origin posts.
    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) return send(200, 'text/html; charset=utf-8', renderPage(reportData(dir, { dryRun }), { live: true }));
    if (req.method === 'GET' && req.url === '/data.json') return send(200, 'application/json', JSON.stringify(reportData(dir, { dryRun })));
    if (req.method === 'POST' && req.url === '/result') {
      const host = req.headers.host || '';
      if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host) || (req.headers.origin && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(req.headers.origin))) return send(403, 'text/plain', 'forbidden');
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1e4) req.destroy(); });
      req.on('end', () => {
        try {
          const { key, result } = JSON.parse(body);
          if (!key) throw new Error('no bet');
          results.set(String(key), result || null);
          try { writeSnapshot(dir, { dryRun }); } catch {}
          log?.info(`Result saved: ${key} -> ${result || 'cleared'}`);
          send(200, 'application/json', JSON.stringify(reportData(dir, { dryRun })));
        } catch (e) { send(400, 'text/plain', e.message); }
      });
      return;
    }
    send(404, 'text/plain', 'not found');
  });
  return new Promise((resolve, reject) => {
    const listen = (p) => server.listen(p, '127.0.0.1');
    server.on('error', (e) => { if (e.code === 'EADDRINUSE' && port) { port = 0; listen(0); } else reject(e); });
    server.on('listening', () => resolve({ url: `http://127.0.0.1:${server.address().port}/`, server }));
    listen(port);
  });
}

const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bets and P&amp;L</title>
<style>
:root {
  color-scheme: light;
  --bg: #f6f6f4; --surface: #fcfcfb; --border: #e4e3de; --grid: #ecebe7;
  --text: #0b0b0b; --text-2: #52514e; --text-3: #7a7974;
  --hardrock: #2a78d6; --betrivers: #eb6834; --other: #6250d6; --all: #0b0b0b;
  --good: #0a7d3b; --bad: #c4322f; --chip: #efeee9;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --bg: #121211; --surface: #1a1a19; --border: #2d2d2b; --grid: #262624;
    --text: #f0efec; --text-2: #c3c2b7; --text-3: #8f8e86;
    --hardrock: #3987e5; --betrivers: #d95926; --other: #9085e9; --all: #f0efec;
    --good: #3fbf6f; --bad: #e66767; --chip: #252523;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --bg: #121211; --surface: #1a1a19; --border: #2d2d2b; --grid: #262624;
  --text: #f0efec; --text-2: #c3c2b7; --text-3: #8f8e86;
  --hardrock: #3987e5; --betrivers: #d95926; --other: #9085e9; --all: #f0efec;
  --good: #3fbf6f; --bad: #e66767; --chip: #252523;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 1100px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { font-size: 22px; margin: 0 0 2px; }
.sub { color: var(--text-2); margin: 0 0 18px; }
.controls { display: flex; flex-wrap: wrap; gap: 10px 16px; align-items: center; margin-bottom: 16px; }
.seg { display: inline-flex; background: var(--chip); border-radius: 9px; padding: 3px; gap: 2px; }
.seg button { border: 0; background: transparent; color: var(--text-2); font: inherit; padding: 6px 12px; border-radius: 7px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
.seg button[aria-pressed="true"] { background: var(--surface); color: var(--text); box-shadow: 0 1px 2px rgba(0,0,0,.12); }
.dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-bottom: 16px; }
.tile { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px; }
.tile .k { color: var(--text-2); font-size: 12px; }
.tile .v { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; margin-top: 2px; }
.tile .n { color: var(--text-3); font-size: 12px; font-variant-numeric: tabular-nums; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 14px 14px 8px; margin-bottom: 16px; position: relative; }
.card h2 { font-size: 15px; margin: 0; }
.card .desc { color: var(--text-2); font-size: 12px; margin: 2px 0 6px; }
.legend { display: flex; flex-wrap: wrap; gap: 4px 14px; color: var(--text-2); font-size: 12px; margin-bottom: 4px; }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.swatch-line { width: 16px; height: 0; border-top: 2px solid; display: inline-block; }
.swatch-dash { width: 16px; height: 0; border-top: 2px dashed; display: inline-block; }
svg { display: block; width: 100%; overflow: visible; }
svg text { fill: var(--text-3); font-size: 11px; font-variant-numeric: tabular-nums; }
.tip { position: absolute; pointer-events: none; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; font-size: 12px; box-shadow: 0 4px 14px rgba(0,0,0,.14); min-width: 160px; display: none; z-index: 2; }
.tip b { display: block; margin-bottom: 4px; }
.tip .row { display: flex; justify-content: space-between; gap: 12px; color: var(--text-2); }
.tip .row span:last-child { color: var(--text); font-variant-numeric: tabular-nums; }
.empty { color: var(--text-2); padding: 30px 0; text-align: center; }
.tablewrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--border); white-space: nowrap; }
th { color: var(--text-2); font-weight: 500; font-size: 12px; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
td.what { white-space: normal; min-width: 220px; }
.pos { color: var(--good); } .neg { color: var(--bad); }
select { font: inherit; font-size: 12px; background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 3px 4px; }
.note { color: var(--text-2); font-size: 12px; }
.pill { display: inline-block; font-size: 11px; padding: 1px 7px; border-radius: 10px; background: var(--chip); color: var(--text-2); }
</style>
</head>
<body>
<main>
  <h1>Bets and P&amp;L</h1>
  <p class="sub" id="sub"></p>
  <div class="controls">
    <div class="seg" id="bookSeg" role="group" aria-label="Book"></div>
    <div class="seg" id="rangeSeg" role="group" aria-label="Time range"></div>
  </div>
  <div class="tiles" id="tiles"></div>
  <section class="card" id="pnlCard">
    <h2>Profit and loss</h2>
    <p class="desc">Running total by when each bet was placed. Actual counts bets with a result; expected is stake × EV for every bet.</p>
    <div class="legend" id="pnlLegend"></div>
    <div id="pnlChart"></div>
    <div class="tip" id="pnlTip"></div>
  </section>
  <section class="card" id="countCard">
    <h2>Bets placed per day</h2>
    <div class="legend" id="countLegend"></div>
    <div id="countChart"></div>
    <div class="tip" id="countTip"></div>
  </section>
  <section class="card">
    <h2>Bets</h2>
    <p class="desc" id="tableNote"></p>
    <div class="tablewrap"><table id="table"></table></div>
  </section>
</main>
<script>
let DATA = __DATA__;
const LIVE = __LIVE__;
const NS = 'http://www.w3.org/2000/svg';
const state = { book: 'all', range: 'all' };
try { Object.assign(state, JSON.parse(localStorage.getItem('evp-view') || '{}')); } catch {}
const saveView = () => { try { localStorage.setItem('evp-view', JSON.stringify(state)); } catch {} };

const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const colorOf = (b) => b === 'all' ? 'var(--all)' : b === 'hardrock' ? 'var(--hardrock)' : b === 'betrivers' ? 'var(--betrivers)' : 'var(--other)';
const label = (b) => b === 'all' ? 'All books' : (DATA.books[b] || b);
const money = (x, sign) => x == null ? '—' : (sign && x > 0 ? '+' : x < 0 ? '−' : '') + '$' + Math.abs(x).toFixed(2);
const pct = (x) => x == null ? '—' : (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x).toFixed(1) + '%';
const odds = (a) => a == null ? '—' : a > 0 ? '+' + a : String(a);
const cls = (x) => x > 0 ? 'pos' : x < 0 ? 'neg' : '';
const dayKey = (t) => { const d = new Date(t); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const dayLabel = (k) => new Date(k + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const when = (t) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function booksPresent() { return [...new Set(DATA.bets.map((b) => b.book))].sort((a, b) => (a === 'hardrock' ? -1 : b === 'hardrock' ? 1 : a.localeCompare(b))); }
function filtered(book = state.book) {
  const cut = state.range === 'all' ? 0 : Date.now() - Number(state.range) * 864e5;
  return DATA.bets.filter((b) => (book === 'all' || b.book === book) && Date.parse(b.placedAt) >= cut);
}

function seg(el, items, cur, on) {
  el.replaceChildren(...items.map(([v, text, color]) => {
    const btn = document.createElement('button');
    btn.setAttribute('aria-pressed', String(v === cur));
    if (color) { const d = document.createElement('span'); d.className = 'dot'; d.style.background = color; btn.append(d); }
    btn.append(text);
    btn.onclick = () => on(v);
    return btn;
  }));
}

function el(tag, attrs = {}, parent) {
  const n = document.createElementNS(NS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (parent) parent.append(n);
  return n;
}
function niceTicks(lo, hi, n = 5, integer = false) {
  if (lo === hi) { lo -= 1; hi += 1; }
  const step0 = (hi - lo) / n, mag = 10 ** Math.floor(Math.log10(step0));
  let step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0);
  if (integer) step = Math.max(1, Math.ceil(step));
  const out = [];
  const top = Math.ceil(hi / step - 1e-9) * step;
  for (let v = Math.floor(lo / step) * step; v <= top + 1e-9; v += step) out.push(Math.round(v * 100) / 100);
  return out;
}

function stats(list) {
  const settled = list.filter((b) => b.profit != null);
  const sum = (xs, f) => xs.reduce((s, b) => s + (f(b) || 0), 0);
  const staked = sum(list, (b) => b.stake), stakedSettled = sum(settled, (b) => b.stake);
  const pnl = sum(settled, (b) => b.profit);
  const withClv = list.filter((b) => b.clv != null);
  return {
    n: list.length, staked, settled: settled.length, pnl, roi: stakedSettled ? pnl / stakedSettled * 100 : null,
    expected: sum(list, (b) => b.expected), expectedSettled: sum(settled, (b) => b.expected),
    avgEv: list.length ? sum(list, (b) => b.ev) / list.length : null,
    clv: withClv.length ? sum(withClv, (b) => b.clv) / withClv.length : null, nClv: withClv.length,
    open: list.length - settled.length,
    record: [['won', 'half-won'], ['lost', 'half-lost'], ['push', 'void']].map((rs) => list.filter((b) => rs.includes(b.result)).length),
  };
}

function tiles(list) {
  const s = stats(list);
  const t = [
    ['Bets placed', String(s.n), money(s.staked) + ' staked'],
    ['Profit (settled)', money(s.pnl, true), s.settled ? s.settled + ' settled · ' + s.record[0] + '-' + s.record[1] + (s.record[2] ? '-' + s.record[2] : '') : 'no results yet', cls(s.pnl)],
    ['ROI (settled)', pct(s.roi), s.settled ? 'expected ' + money(s.expectedSettled, true) + ' on these' : '—', cls(s.roi)],
    ['Expected profit', money(s.expected, true), 'avg EV ' + pct(s.avgEv)],
    ['Avg CLV', pct(s.clv), s.nClv ? s.nClv + ' with a close' : 'no closes yet', cls(s.clv)],
    ['Waiting for result', String(s.open), LIVE ? 'mark them below' : 'open Show bets to mark'],
  ];
  document.getElementById('tiles').replaceChildren(...t.map(([k, v, n, c]) => {
    const d = document.createElement('div'); d.className = 'tile';
    d.innerHTML = '<div class="k"></div><div class="v"></div><div class="n"></div>';
    d.children[0].textContent = k; d.children[1].textContent = v; d.children[2].textContent = n;
    if (c) d.children[1].classList.add(c);
    return d;
  }));
}

function legend(id, items) {
  document.getElementById(id).replaceChildren(...items.map(([text, color, dashed]) => {
    const s = document.createElement('span');
    const m = document.createElement('span');
    if (dashed === 'dot') { m.className = 'dot'; m.style.background = color; }
    else { m.className = dashed ? 'swatch-dash' : 'swatch-line'; m.style.borderColor = color; }
    s.append(m, text);
    return s;
  }));
}

function pnlChart(list) {
  const host = document.getElementById('pnlChart'), tip = document.getElementById('pnlTip');
  const color = colorOf(state.book);
  legend('pnlLegend', [['Actual (settled bets)', color], ['Expected (stake × EV)', 'var(--text-3)', true]]);
  if (!list.length) { host.innerHTML = '<div class="empty">No bets in this view yet.</div>'; return; }
  let act = 0, exp = 0;
  const pts = list.map((b) => { if (b.profit != null) act += b.profit; exp += b.expected || 0; return { t: Date.parse(b.placedAt), act, exp, b }; });
  const W = Math.max(320, host.clientWidth), H = 280, m = { l: 52, r: 12, t: 10, b: 26 };
  const t0 = pts[0].t, t1 = Math.max(pts[pts.length - 1].t, t0 + 36e5);
  const vals = pts.flatMap((p) => [p.act, p.exp]).concat(0);
  const ticks = niceTicks(Math.min(...vals), Math.max(...vals));
  const y0 = ticks[0], y1 = ticks[ticks.length - 1];
  const X = (t) => m.l + (t - t0) / (t1 - t0) * (W - m.l - m.r);
  const Y = (v) => m.t + (y1 - v) / (y1 - y0) * (H - m.t - m.b);
  const svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, height: H, role: 'img', 'aria-label': 'Running profit and loss' });
  for (const v of ticks) {
    el('line', { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v), stroke: v === 0 ? css('--text-3') : css('--grid'), 'stroke-width': 1 }, svg);
    el('text', { x: m.l - 8, y: Y(v) + 4, 'text-anchor': 'end' }, svg).textContent = ticks.every(Number.isInteger) ? money(v).replace('.00', '') : money(v);
  }
  const days = Math.max(1, Math.round((t1 - t0) / 864e5));
  const nx = Math.min(6, Math.max(2, Math.floor((W - m.l - m.r) / 110)));
  for (let i = 0; i <= nx; i++) {
    const t = t0 + (t1 - t0) * i / nx;
    el('text', { x: X(t), y: H - 6, 'text-anchor': i === 0 ? 'start' : i === nx ? 'end' : 'middle' }, svg).textContent =
      days > 2 ? new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric' });
  }
  const path = (f) => pts.reduce((d, p, i) => d + (i ? ' H' + X(p.t).toFixed(1) + ' V' : 'M' + X(t0).toFixed(1) + ' ' + Y(0).toFixed(1) + ' H' + X(p.t).toFixed(1) + ' V') + Y(f(p)).toFixed(1), '');
  el('path', { d: path((p) => p.exp), fill: 'none', stroke: css('--text-3'), 'stroke-width': 2, 'stroke-dasharray': '5 4', 'stroke-linejoin': 'round' }, svg);
  const actualPath = el('path', { d: path((p) => p.act), fill: 'none', 'stroke-width': 2, 'stroke-linejoin': 'round' }, svg);
  actualPath.style.stroke = color;
  const last = pts[pts.length - 1];
  const endDot = el('circle', { cx: X(last.t), cy: Y(last.act), r: 4, 'stroke-width': 2 }, svg);
  endDot.style.fill = color; endDot.style.stroke = css('--surface');
  // Hover: nearest bet.
  const cross = el('line', { y1: m.t, y2: H - m.b, stroke: css('--text-3'), 'stroke-width': 1, visibility: 'hidden' }, svg);
  const dot = el('circle', { r: 5, 'stroke-width': 2, visibility: 'hidden' }, svg);
  dot.style.fill = color; dot.style.stroke = css('--surface');
  const hit = el('rect', { x: m.l, y: 0, width: W - m.l - m.r, height: H, fill: 'transparent' }, svg);
  const move = (e) => {
    const r = svg.getBoundingClientRect(), x = (e.clientX - r.left) * W / r.width;
    let best = pts[0];
    for (const p of pts) if (Math.abs(X(p.t) - x) < Math.abs(X(best.t) - x)) best = p;
    cross.setAttribute('x1', X(best.t)); cross.setAttribute('x2', X(best.t)); cross.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', X(best.t)); dot.setAttribute('cy', Y(best.act)); dot.setAttribute('visibility', 'visible');
    const b = best.b;
    tip.innerHTML = '';
    const h = document.createElement('b'); h.textContent = when(b.placedAt); tip.append(h);
    const row = (k, v, c) => { const d = document.createElement('div'); d.className = 'row'; d.innerHTML = '<span></span><span></span>'; d.children[0].textContent = k; d.children[1].textContent = v; if (c) d.children[1].className = c; tip.append(d); };
    row('Actual P&L', money(best.act, true), cls(best.act));
    row('Expected', money(best.exp, true));
    const what = document.createElement('div'); what.className = 'note'; what.style.marginTop = '6px';
    what.textContent = label(b.book) + ': ' + b.selection + (b.line != null ? ' ' + b.line : '') + ' ' + odds(b.odds) + ', $' + b.stake + ' → ' + (b.result ? b.result + ' ' + money(b.profit, true) : 'no result yet');
    tip.append(what);
    tip.style.display = 'block';
    const px = X(best.t) * r.width / W;
    tip.style.left = Math.min(px + 24, host.clientWidth - tip.offsetWidth + 14) + 'px';
    tip.style.top = (Y(best.act) * r.height / H + 40) + 'px';
  };
  hit.addEventListener('pointermove', move);
  hit.addEventListener('pointerleave', () => { tip.style.display = 'none'; cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); });
  host.replaceChildren(svg);
}

function countChart(list) {
  const host = document.getElementById('countChart'), tip = document.getElementById('countTip');
  const books = state.book === 'all' ? booksPresent() : [state.book];
  legend('countLegend', books.length > 1 ? books.map((b) => [label(b), colorOf(b), 'dot']) : []);
  if (!list.length) { host.innerHTML = '<div class="empty">No bets in this view yet.</div>'; return; }
  // Every day from the first bet to today, so quiet days show as gaps.
  const first = new Date(list[0].placedAt); first.setHours(12, 0, 0, 0);
  const keys = [];
  for (let d = new Date(first); dayKey(d) <= dayKey(Date.now()); d.setDate(d.getDate() + 1)) keys.push(dayKey(d));
  const by = Object.fromEntries(keys.map((k) => [k, Object.fromEntries(books.map((b) => [b, { n: 0, stake: 0 }]))]));
  for (const b of list) { const c = by[dayKey(b.placedAt)]?.[b.book]; if (c) { c.n++; c.stake += b.stake; } }
  const W = Math.max(320, host.clientWidth), H = 200, m = { l: 36, r: 8, t: 10, b: 26 };
  const max = Math.max(1, ...keys.map((k) => books.reduce((s, b) => s + by[k][b].n, 0)));
  const ticks = niceTicks(0, max, 4, true);
  const yTop = ticks[ticks.length - 1];
  const Y = (v) => m.t + (yTop - v) / yTop * (H - m.t - m.b);
  const slot = (W - m.l - m.r) / keys.length, bw = Math.max(2, Math.min(28, slot * 0.7));
  const svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, height: H, role: 'img', 'aria-label': 'Bets placed per day' });
  for (const v of ticks) {
    el('line', { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v), stroke: css('--grid'), 'stroke-width': 1 }, svg);
    el('text', { x: m.l - 8, y: Y(v) + 4, 'text-anchor': 'end' }, svg).textContent = v;
  }
  const every = Math.ceil(keys.length / Math.max(2, Math.floor((W - m.l) / 64)));
  keys.forEach((k, i) => {
    const cx = m.l + slot * (i + 0.5);
    if (i % every === 0 || i === keys.length - 1 && keys.length < 8) el('text', { x: cx, y: H - 6, 'text-anchor': 'middle' }, svg).textContent = dayLabel(k);
    let acc = 0;
    const segs = books.filter((b) => by[k][b].n);
    segs.forEach((b, j) => {
      const n = by[k][b].n, top = j === segs.length - 1;
      const y = Y(acc + n), h = Y(acc) - Y(acc + n) - (j > 0 ? 2 : 0);
      const r = Math.min(4, bw / 2, h);
      const x = cx - bw / 2;
      // Rounded top on the top segment only, square at the baseline.
      const d = top
        ? 'M' + x + ' ' + (y + h) + ' V' + (y + r) + ' Q' + x + ' ' + y + ' ' + (x + r) + ' ' + y + ' H' + (x + bw - r) + ' Q' + (x + bw) + ' ' + y + ' ' + (x + bw) + ' ' + (y + r) + ' V' + (y + h) + ' Z'
        : 'M' + x + ' ' + (y + h) + ' V' + y + ' H' + (x + bw) + ' V' + (y + h) + ' Z';
      const p = el('path', { d }, svg); p.style.fill = colorOf(b);
      acc += n;
    });
    const hit = el('rect', { x: cx - slot / 2, y: m.t, width: slot, height: H - m.t - m.b, fill: 'transparent' }, svg);
    hit.addEventListener('pointermove', () => {
      tip.innerHTML = '';
      const h = document.createElement('b'); h.textContent = new Date(k + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }); tip.append(h);
      for (const b of books) { const d = document.createElement('div'); d.className = 'row'; d.innerHTML = '<span></span><span></span>'; d.children[0].textContent = label(b); d.children[1].textContent = by[k][b].n + ' bet' + (by[k][b].n === 1 ? '' : 's') + ' · $' + by[k][b].stake.toFixed(0); tip.append(d); }
      tip.style.display = 'block';
      const r = svg.getBoundingClientRect(), px = cx * r.width / W;
      tip.style.left = Math.max(8, Math.min(px + 16, host.clientWidth - tip.offsetWidth + 14)) + 'px';
      tip.style.top = '60px';
    });
    hit.addEventListener('pointerleave', () => { tip.style.display = 'none'; });
  });
  host.replaceChildren(svg);
}

async function setResult(key, result, sel) {
  sel.disabled = true;
  try {
    const r = await fetch('/result', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, result }) });
    if (!r.ok) throw new Error(await r.text());
    DATA = await r.json();
    render();
  } catch (e) {
    sel.disabled = false;
    alert('Could not save: ' + e.message + '. Is the Show bets window still open?');
  }
}

function table(list) {
  const tb = document.getElementById('table');
  document.getElementById('tableNote').textContent = LIVE
    ? 'Pick a result for each bet once it settles. It saves to results.json next to the app and the charts update.'
    : 'Read-only copy. Run Show bets to mark results.';
  const head = '<tr><th>Placed</th><th>Book</th><th>Bet</th><th class="num">Odds</th><th class="num">Stake</th><th class="num">EV</th><th class="num">CLV</th><th>Result</th><th class="num">Profit</th></tr>';
  tb.innerHTML = head;
  for (const b of [...list].reverse()) {
    const tr = document.createElement('tr');
    const cells = [when(b.placedAt), label(b.book), '', odds(b.odds), '$' + b.stake, pct(b.ev), pct(b.clv), '', money(b.profit, true)];
    cells.forEach((c, i) => {
      const td = document.createElement('td');
      if ([3, 4, 5, 6, 8].includes(i)) td.className = 'num';
      if (i === 2) {
        td.className = 'what';
        td.textContent = (b.event || '') + ': ' + (b.market || '') + ' ' + (b.selection || '') + (b.line != null ? ' ' + b.line : '');
        if (b.live) { const p = document.createElement('span'); p.className = 'pill'; p.textContent = 'live'; td.append(' ', p); }
      } else if (i === 7) {
        if (LIVE) {
          const sel = document.createElement('select');
          for (const [v, t] of [['', 'not settled'], ['won', 'won'], ['lost', 'lost'], ['push', 'push'], ['void', 'void'], ['half-won', 'half won'], ['half-lost', 'half lost']]) {
            const o = document.createElement('option'); o.value = v; o.textContent = t; if ((b.result || '') === v) o.selected = true; sel.append(o);
          }
          sel.onchange = () => setResult(b.key, sel.value, sel);
          td.append(sel);
        } else td.textContent = b.result || 'not settled';
      } else td.textContent = c;
      if (i === 8 && b.profit != null) td.classList.add(cls(b.profit) || 'num');
      tr.append(td);
    });
    tb.append(tr);
  }
}

function render() {
  const books = booksPresent();
  if (state.book !== 'all' && !books.includes(state.book)) state.book = 'all';
  seg(document.getElementById('bookSeg'), [['all', 'All books (' + filtered('all').length + ')', null], ...books.map((b) => [b, label(b) + ' (' + filtered(b).length + ')', colorOf(b)])], state.book, (v) => { state.book = v; saveView(); render(); });
  seg(document.getElementById('rangeSeg'), [['all', 'All time'], ['30', '30 days'], ['7', '7 days']], state.range, (v) => { state.range = v; saveView(); render(); });
  document.getElementById('sub').textContent = (DATA.dryRun ? 'Demo bets (dry run). ' : '') + 'Updated ' + when(DATA.generatedAt) + ' · ' + DATA.bets.length + ' bets in the log';
  const list = filtered();
  tiles(list); pnlChart(list); countChart(list); table(list);
}
render();
let rt; addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(render, 150); });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', render);
// Pick up bets the placer logs while this page is open.
if (LIVE) setInterval(async () => {
  if (document.activeElement?.tagName === 'SELECT') return;
  try { const r = await fetch('/data.json'); if (r.ok) { DATA = await r.json(); render(); } } catch {}
}, 60000);
</script>
</body>
</html>`;
