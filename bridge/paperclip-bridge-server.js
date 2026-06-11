/* ============================================================
   paperclip-bridge-server.js  (v2 — two-way)
   1) Watches Paperclip's data folder, broadcasts agent events (read-only).
   2) Accepts {cmd:"assign", agent, title} from the dashboard and creates
      a REAL task in Paperclip via its HTTP API (front door, never the files).

   .env on the VPS:
     BRIDGE_KEY=...                         # dashboard auth (required)
     PAPERCLIP_DIR=/data/paperclip          # set by docker-compose
     PAPERCLIP_API=http://host.docker.internal:45799
     PAPERCLIP_EMAIL=you@example.com        # a real Paperclip login
     PAPERCLIP_PASSWORD=...
     PAPERCLIP_COMPANY=OIB                  # company slug/key/name
     ASSIGN_PATH=                           # optional override, e.g. /api/companies/{company}/issues
   ============================================================ */

const os = require('os');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PAPERCLIP_DIR = process.env.PAPERCLIP_DIR || path.join(os.homedir(), '.paperclip');
const PORT = parseInt(process.env.PORT || '8787', 10);
const KEY = process.env.BRIDGE_KEY || '';
const API = (process.env.PAPERCLIP_API || '').replace(/\/$/, '');
const EMAIL = process.env.PAPERCLIP_EMAIL || '';
const PASS = process.env.PAPERCLIP_PASSWORD || '';
const WANT_COMPANY = (process.env.PAPERCLIP_COMPANY || '').toLowerCase();
const AGENTS = (process.env.AGENTS || 'CEO,Copywriter,CTO,Designer,LandingPageBuilder,VideoEditor')
  .split(',').map(s => s.trim()).filter(Boolean);

/* ---------------- websocket server with key auth ---------------- */
const wss = new WebSocketServer({ port: PORT });
const clients = new Set();
wss.on('connection', (ws, req) => {
  if (KEY) {
    let ok = false;
    try { ok = new URL(req.url, 'http://x').searchParams.get('key') === KEY; } catch {}
    if (!ok) { ws.close(4001, 'bad key'); console.log('[bridge] rejected client (bad key)'); return; }
  }
  clients.add(ws);
  console.log('[bridge] dashboard connected ✔  (' + clients.size + ' online)');
  ws.send(JSON.stringify({ agent: 'CEO', state: 'communicating',
    message: 'Bridge online. Watching ' + PAPERCLIP_DIR + (API ? ' · assignments enabled' : '') }));
  ws.on('close', () => clients.delete(ws));
  ws.on('message', raw => handleClientMessage(ws, raw));
});
function broadcast(ev) {
  const s = JSON.stringify(ev);
  for (const c of clients) { try { c.send(s); } catch {} }
  console.log('[event]', s);
}

/* ---------------- Paperclip API client (cookie session) ---------------- */
let cookieJar = {};
let companyCache = null, agentsCache = null, lastGood = null;
const cookieHeader = () => Object.entries(cookieJar).map(([k, v]) => k + '=' + v).join('; ');
function storeSetCookies(res) {
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of sc) {
    const kv = c.split(';')[0], i = kv.indexOf('=');
    if (i > 0) cookieJar[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  }
}
async function login() {
  cookieJar = {};
  const r = await fetch(API + '/api/auth/sign-in/email', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: API },
    body: JSON.stringify({ email: EMAIL, password: PASS })
  });
  storeSetCookies(r);
  if (!r.ok) throw new Error('login failed: ' + r.status + ' ' + (await r.text()).slice(0, 200));
  console.log('[api] logged in as', EMAIL);
}
async function pcFetch(p, opts = {}, retry = true) {
  const r = await fetch(API + p, { ...opts,
    headers: { 'content-type': 'application/json', origin: API, cookie: cookieHeader(), ...(opts.headers || {}) } });
  storeSetCookies(r);
  if (r.status === 401 && retry) { await login(); return pcFetch(p, opts, false); }
  return r;
}
async function getCompany() {
  const r = await pcFetch('/api/companies');
  if (!r.ok) throw new Error('GET /api/companies -> ' + r.status);
  const j = await r.json();
  const arr = Array.isArray(j) ? j : (j.companies || j.data || []);
  if (!arr.length) throw new Error('no companies visible to this user');
  const c = arr.find(x => [x.slug, x.key, x.code, x.name, x.id]
    .filter(Boolean).some(v => String(v).toLowerCase() === WANT_COMPANY)) || arr[0];
  console.log('[api] company:', JSON.stringify(c).slice(0, 240));
  return c;
}
async function getAgents(cid) {
  const tries = ['/api/companies/' + cid + '/agents', '/api/agents?companyId=' + cid, '/api/agents'];
  for (const p of tries) {
    try {
      const r = await pcFetch(p); if (!r.ok) continue;
      const j = await r.json();
      const arr = Array.isArray(j) ? j : (j.agents || j.data || []);
      if (arr.length) {
        console.log('[api] agents via ' + p + ':', arr.map(a => a.name || a.id).join(', '));
        return arr;
      }
    } catch {}
  }
  console.log('[api] could not list agents (will create unassigned tasks mentioning the agent)');
  return [];
}
async function createTask(agentName, title, description) {
  if (!API || !EMAIL || !PASS)
    return { ok: false, error: 'Assignment not configured: set PAPERCLIP_API / PAPERCLIP_EMAIL / PAPERCLIP_PASSWORD in .env' };
  if (!cookieHeader()) await login();
  if (!companyCache) companyCache = await getCompany();
  const cid = companyCache.id || companyCache.companyId || companyCache.slug;
  if (!agentsCache) agentsCache = await getAgents(cid);
  const ag = agentsCache.find(a => String(a.name || '').toLowerCase() === agentName.toLowerCase());
  const aid = ag && (ag.id || ag.agentId);
  const desc = description || ('Assigned to ' + agentName + ' from Agent House (founder dashboard).');
  const base = { title, description: desc };
  const bodies = [];
  if (aid) bodies.push({ ...base, assigneeAgentId: aid, status: 'todo' }, { ...base, assigneeId: aid }, { ...base, agentId: aid },
                       { ...base, assigneeAgentId: aid }, { ...base, assignee: aid });
  bodies.push({ ...base });
  const paths = [];
  if (process.env.ASSIGN_PATH) paths.push(process.env.ASSIGN_PATH.replaceAll('{company}', String(cid)));
  if (lastGood) paths.push(lastGood);
  paths.push('/api/companies/' + cid + '/issues', '/api/issues');
  const attempts = [];
  for (const p of [...new Set(paths)]) {
    for (const b of bodies) {
      const body = p.includes('/companies/') ? b : { ...b, companyId: cid };
      try {
        const r = await pcFetch(p, { method: 'POST', body: JSON.stringify(body) });
        const text = (await r.text()).slice(0, 240);
        attempts.push(p + ' -> ' + r.status);
        if (r.ok) {
          lastGood = p;
          console.log('[assign] CREATED via', p, '| body keys:', Object.keys(body).join(','), '| resp:', text);
          return { ok: true, via: p };
        }
      } catch (e) { attempts.push(p + ' -> ERR ' + e.message); }
    }
  }
  console.log('[assign] all candidates failed:', attempts.join(' | '));
  console.log('[assign] To fix: create a task in the Paperclip UI with DevTools (F12 -> Network),');
  console.log('         note the POST URL + JSON body, then set ASSIGN_PATH in .env and tell Claude the body shape.');
  return { ok: false, error: 'No API route accepted the task (' + attempts.join(' | ') + ')' };
}
async function handleClientMessage(ws, raw) {
  let m; try { m = JSON.parse(raw); } catch { return; }
  if (m && m.cmd === 'assign' && m.agent && m.title) {
    const agent = String(m.agent), title = String(m.title).slice(0, 300);
    console.log('[assign] request:', agent, '-', title);
    broadcast({ agent, state: 'communicating', message: 'Incoming task: ' + title });
    let res;
    try { res = await createTask(agent, title, m.description && String(m.description)); }
    catch (e) { res = { ok: false, error: e.message }; }
    try { ws.send(JSON.stringify({ type: 'assign_result', ok: !!res.ok, agent, title,
      info: res.ok ? ('created via ' + res.via) : res.error })); } catch {}
    if (res.ok) broadcast({ agent, state: 'working', message: title });
  }
}

/* ---------------- file watching -> events ---------------- */
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
    obj = filePath.endsWith('.jsonl') ? JSON.parse(raw.trim().split('\n').pop()) : JSON.parse(raw);
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
if (!fs.existsSync(PAPERCLIP_DIR)) {
  console.error('[bridge] Folder not found:', PAPERCLIP_DIR);
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
  console.log('[bridge] recursive watch unavailable (' + e.code + ') — polling every 2s');
}
if (!watching) {
  const seen = new Map();
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
  scan(PAPERCLIP_DIR, 0);
  setInterval(() => scan(PAPERCLIP_DIR, 0), 2000);
}
console.log('[bridge] Watching', PAPERCLIP_DIR);
console.log('[bridge] WebSocket on port ' + PORT + (KEY ? '  (key required)' : '  (NO KEY)'));
console.log('[bridge] Assignments: ' + (API && EMAIL ? 'ENABLED -> ' + API : 'disabled (set PAPERCLIP_API/EMAIL/PASSWORD)'));
