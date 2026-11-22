// Local WebSocket server the Chrome extension connects to. The engine sends
// "run this request inside the logged-in sportsbook tab" and gets the response back.
import { WebSocketServer } from 'ws';
import { log } from '../log.js';

export function startBridge(port, { reloadExtension = false, quiet = false, hello = null } = {}) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port });
  wss.on('error', (e) => log.err(e.code === 'EADDRINUSE' ? `Port ${port} for the Chrome extension is in use: is another ev-placer window open (Show bets checking results lets go within 90s)? Close it and start again` : `Chrome extension link on port ${port} failed: ${e.message}`));
  let sock = null;
  let tabs = [];
  let seq = 0;
  const pending = new Map();   // id -> { resolve, reject, t, book, at }
  // Requests still waiting when the extension's link drops can never be answered: fail them now
  // instead of letting each one sit until its own timeout.
  const failPending = (why) => {
    for (const [id, p] of pending) { clearTimeout(p.t); pending.delete(id); p.reject(new Error(why)); }
  };

  wss.on('connection', (ws, req) => {
    // Only accept the extension (chrome-extension:// origin) on localhost.
    if (!String(req.headers.origin || '').startsWith('chrome-extension://')) return ws.close();
    if (reloadExtension) {
      // Extension files were just updated on disk: tell Chrome to reload it once.
      reloadExtension = false;
      log.info('Extension updated, reloading it in Chrome');
      ws.send(JSON.stringify({ type: 'reload' }));
      return;
    }
    if (sock && sock !== ws) sock.terminate();   // an older link the extension already gave up on
    sock = ws;
    ws.alive = true;
    ws.on('pong', () => { ws.alive = true; });
    if (!quiet) log.info('Chrome extension connected');
    if (hello) ws.send(JSON.stringify(hello));   // settings the extension needs (Gambit auto login on/off)
    ws.on('message', (buf) => {
      let m; try { m = JSON.parse(buf); } catch { return; }
      if (m.type === 'tabs') { tabs = m.tabs; return; }
      if (m.type === 'reloaded') { log.warn(`Chrome extension reloaded the ${m.book} tab: ${m.why}`); return; }
      if (m.type === 'hello') { if (!quiet) log.info(`Chrome extension version ${m.version}`); return; }
      if (m.type === 'login') {
        if (m.note) log.warn(m.note);
        else if (m.start) log.warn(`Logging back in to Gambit with Chrome's saved password (${m.why})`);
        else if (m.ok) log.good(m.why);
        else log.warn(`Gambit auto login didn't work: ${m.why}. It tries again in a few minutes; or log in by hand in the Gambit tab`);
        return;
      }
      const p = pending.get(m.id);
      if (p) { pending.delete(m.id); clearTimeout(p.t); p.resolve(m); }
    });
    ws.on('close', () => {
      if (sock !== ws) return;
      sock = null; tabs = [];
      if (!quiet) log.warn('Chrome extension disconnected');
      failPending('Chrome extension disconnected while waiting for its answer');
    });
  });

  // Heartbeat: Chrome answers a ping on its own. A link that stops answering (Chrome froze, the
  // PC slept, the extension's worker was stopped without closing the socket) is cut so the
  // extension's reconnect (every 3s) gives a fresh one, instead of every request timing out.
  const beat = setInterval(() => {
    const ws = sock;
    if (!ws) return;
    if (!ws.alive) {
      log.warn('Chrome extension stopped answering: dropping the link so it reconnects');
      ws.terminate();   // 'close' handler clears sock and fails what was waiting
      return;
    }
    ws.alive = false;
    try { ws.ping(); } catch {}
  }, 10000);
  beat.unref?.();

  return {
    /** Let go of the port (so the placer can take it). */
    close: () => new Promise((r) => { clearInterval(beat); for (const c of wss.clients) c.terminate(); wss.close(() => r()); }),
    connected: () => !!sock,
    hasTab: (book) => tabs.some((t) => t.book === book),
    /** Tell the extension something without waiting for a reply (alerts, tab reloads). */
    tell(msg) { if (sock?.readyState === 1) sock.send(JSON.stringify(msg)); },
    /** Run fetch() inside the book's tab. request = {url, method, headers, body, storageHeaders} */
    send(book, request, timeoutMs = 15000) {
      if (!sock) return Promise.reject(new Error('Chrome extension not connected'));
      const id = ++seq;
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`no answer from the Chrome extension in ${Math.round(timeoutMs / 1000)}s (bridge timeout${book === 'gambit' ? ': Gambit or the internet is slow' : ''})`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, t });
        sock.send(JSON.stringify({ id, type: 'fetch', book, request }));
      }).then((m) => { if (m.error) throw new Error(m.error); return m; });
    },
  };
}
