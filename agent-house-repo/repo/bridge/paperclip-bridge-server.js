/* ============================================================
   paperclip-bridge-server.js  (VPS edition)
   Watches Paperclip's data folder and broadcasts agent events
   over WebSocket — built to run on a public Linux server.

   New vs the local version:
   - BRIDGE_KEY auth: clients must connect with ?key=YOURSECRET
   - Works on Linux even without recursive fs.watch (poll fallback)
   - Config via env vars

   RUN (on the VPS):
     npm install ws
     PAPERCLIP_DIR=/root/.paperclip BRIDGE_KEY=change-me node paperclip-bridge-server.js
   Keep alive across reboots:
     npm install -g pm2
     BRIDGE_KEY=change-me pm2 start paperclip-bridge-server.js --name bridge
     pm2 save && pm2 startup
   ============================================================ */

const os = require('os');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PAPERCLIP_DIR = process.env.PAPERCLIP_DIR || path.join(os.homedir(), '.paperclip');
const PORT = parseInt(process.env.PORT || '8787', 10);
const KEY = process.env.BRIDGE_KEY || '';           // empty = no auth (local use only!)
const AGENTS = (process.env.AGENTS || 'CEO,Copywriter,CTO,Designer,LandingPageBuilder,VideoEditor')
  .split(',').map(s => s.trim()).filter(Boolean);

/* ---------------- websocket server with key auth ---------------- */
const wss = new WebSocketServer({ port: PORT });
const clients = new Set();
wss.on('connection', (ws, req) => {
  if (KEY) {
    let ok = false;
    try {
      const u = new URL(req.url, 'http://x');
      ok = u.searchParams.get('key') === KEY;
    } catch {}
    if (!ok) { ws.close(4001, 'bad key'); console.log('[bridge] rejected client (bad key)'); return; }
  }
  clients.add(ws);
  console.log('[bridge] dashboard connected ✔  (' + clients.size + ' online)');
  ws.send(JSON.stringify({ agent: 'CEO', state: 'communicating',
    message: 'Bridge online. Watching ' + PAPERCLIP_DIR }));
  ws.on('close', () => clients.delete(ws));
});
function broadcast(ev) {
  const s = JSON.stringify(ev);
  for (const c of clients) { try { c.send(s); } catch {} }
  console.log('[event]', s);
}

/* ---------------- map changed files to events ---------------- */
const STATUS_MAP = {
  in_progress: 'working', running: 'working', active: 'working', executing: 'working',
  blocked: 'blocked', waiting: 'blocked', needs_input: 'blocked',
  done: 'done', succeeded: 'done', complete: 'done', completed: 'done', closed: 'done',
  idle: 'idle', open: 'idle', todo: 'idle',
};
function guessAgent(filePath, obj) {
  for (const k of ['agent', 'agent_name', 'assignee', 'owner', 'worker'])
    if (obj && typeof obj[k] === 'string') {
      const hit = AGENTS.find(a => obj[k].toLowerCase().includes(a.toLowerCase()));
      if (hit) return hit;
    }
  const lower = filePath.toLowerCase();
  return AGENTS.find(a => lower.includes(a.toLowerCase())) || null;
}
function mapChange(filePath) {
  if (!filePath.endsWith('.json') && !filePath.endsWith('.jsonl')) return;
  let raw; try { raw = fs.readFileSync(filePath, 'utf8'); } catch { return; }
  let obj = null;
  try {
    obj = filePath.endsWith('.jsonl')
      ? JSON.parse(raw.trim().split('\n').pop())
      : JSON.parse(raw);
  } catch { return; }
  const status = String(obj.status || obj.state || obj.phase || '').toLowerCase();
  const agent = guessAgent(filePath, obj);
  const mapped = STATUS_MAP[status];
  console.log('[discovery]', path.relative(PAPERCLIP_DIR, filePath),
    '| keys:', Object.keys(obj).slice(0, 10).join(','),
    '| status:', status || '(none)', '| agent:', agent || '(unknown)');
  if (agent && mapped) {
    broadcast({ agent, state: mapped,
      message: obj.title || obj.summary || obj.task || obj.message || undefined });
  }
}

/* ---------------- watching: recursive if possible, else poll ---------------- */
if (!fs.existsSync(PAPERCLIP_DIR)) {
  console.error('[bridge] Folder not found:', PAPERCLIP_DIR);
  console.error('         Set it:  PAPERCLIP_DIR=/path/to/.paperclip node paperclip-bridge-server.js');
  process.exit(1);
}
const timers = new Map();
function debounced(full) {
  clearTimeout(timers.get(full));
  timers.set(full, setTimeout(() => { timers.delete(full); mapChange(full); }, 250));
}
let watching = false;
try {
  fs.watch(PAPERCLIP_DIR, { recursive: true }, (evt, fname) => {
    if (fname) debounced(path.join(PAPERCLIP_DIR, fname));
  });
  watching = true;
  console.log('[bridge] recursive watch active');
} catch (e) {
  console.log('[bridge] recursive watch unavailable (' + e.code + ') — using 2s polling instead');
}
if (!watching) {
  const seen = new Map(); // path -> mtimeMs
  function scan(dir, depth) {
    if (depth > 8) return;
    let items; try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const full = path.join(dir, it.name);
      if (it.isDirectory()) { if (it.name !== 'node_modules' && it.name[0] !== '.') scan(full, depth + 1); }
      else if (it.name.endsWith('.json') || it.name.endsWith('.jsonl')) {
        let st; try { st = fs.statSync(full); } catch { continue; }
        const prev = seen.get(full);
        if (prev === undefined) seen.set(full, st.mtimeMs);
        else if (st.mtimeMs > prev) { seen.set(full, st.mtimeMs); debounced(full); }
      }
    }
  }
  scan(PAPERCLIP_DIR, 0);            // prime without firing events
  setInterval(() => scan(PAPERCLIP_DIR, 0), 2000);
}

console.log('[bridge] Watching', PAPERCLIP_DIR);
console.log('[bridge] WebSocket on port ' + PORT + (KEY ? '  (key required)' : '  (NO KEY — local use only)'));
