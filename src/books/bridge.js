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
  const pending = new Map();

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
    sock = ws;
    if (!quiet) log.info('Chrome extension connected');
    if (hello) ws.send(JSON.stringify(hello));   // settings the extension needs (Gambit auto login on/off)
    ws.on('message', (buf) => {
      let m; try { m = JSON.parse(buf); } catch { return; }
      if (m.type === 'tabs') { tabs = m.tabs; return; }
      if (m.type === 'reloaded') { log.warn(`Chrome extension reloaded the ${m.book} tab: ${m.why}`); return; }
      if (m.type === 'login') {
        if (m.start) log.warn(`Logging back in to Gambit with Chrome's saved password (${m.why})`);
        else if (m.ok) log.good(m.why);
        else log.warn(`Gambit auto login didn't work: ${m.why}. It tries again in a few minutes; or log in by hand in the Gambit tab`);
        return;
      }
      const p = pending.get(m.id);
      if (p) { pending.delete(m.id); clearTimeout(p.t); p.resolve(m); }
    });
    ws.on('close', () => { if (sock === ws) { sock = null; tabs = []; if (!quiet) log.warn('Chrome extension disconnected'); } });
  });

  return {
    /** Let go of the port (so the placer can take it). */
    close: () => new Promise((r) => { for (const c of wss.clients) c.terminate(); wss.close(() => r()); }),
    connected: () => !!sock,
    hasTab: (book) => tabs.some((t) => t.book === book),
    /** Tell the extension something without waiting for a reply (alerts, tab reloads). */
    tell(msg) { if (sock?.readyState === 1) sock.send(JSON.stringify(msg)); },
    /** Run fetch() inside the book's tab. request = {url, method, headers, body, storageHeaders} */
    send(book, request, timeoutMs = 15000) {
      if (!sock) return Promise.reject(new Error('Chrome extension not connected'));
      const id = ++seq;
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => { pending.delete(id); reject(new Error('bridge timeout')); }, timeoutMs);
        pending.set(id, { resolve, t });
        sock.send(JSON.stringify({ id, type: 'fetch', book, request }));
      }).then((m) => { if (m.error) throw new Error(m.error); return m; });
    },
  };
}
