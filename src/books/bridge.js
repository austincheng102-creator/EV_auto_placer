// Local WebSocket server the Chrome extension connects to. The engine sends
// "run this request inside the logged-in sportsbook tab" and gets the response back.
import { WebSocketServer } from 'ws';
import { log } from '../log.js';

export function startBridge(port, { reloadExtension = false } = {}) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port });
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
    log.info('Chrome extension connected');
    ws.on('message', (buf) => {
      let m; try { m = JSON.parse(buf); } catch { return; }
      if (m.type === 'tabs') { tabs = m.tabs; return; }
      const p = pending.get(m.id);
      if (p) { pending.delete(m.id); clearTimeout(p.t); p.resolve(m); }
    });
    ws.on('close', () => { if (sock === ws) { sock = null; tabs = []; log.warn('Chrome extension disconnected'); } });
  });

  return {
    connected: () => !!sock,
    hasTab: (book) => tabs.some((t) => t.book === book),
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
