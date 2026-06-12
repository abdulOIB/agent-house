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
  /* replay current real states so a refreshed dashboard is instantly truthful */
  try {
    const snap = [...agentLive.entries()]
      .filter(([, v]) => v && v.st && v.st !== 'idle')
      .map(([agent, v]) => ({ agent, state: v.st === 'done' ? 'idle' : v.st, message: v.msg }));
    if (snap.length) ws.send(JSON.stringify(snap));
  } catch {}
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
  if ((r.status === 401 || r.status === 403) && retry) { await login(); return pcFetch(p, opts, false); }
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
  /* Paperclip truncates long titles (~300 chars) — keep title short, put the FULL brief in the description */
  const fullBrief = String(title || '');
  const shortTitle = fullBrief.length > 110 ? fullBrief.slice(0, 110).trim() + '…' : fullBrief;
  const fullDesc = fullBrief.length > 110
    ? desc + '\n\n## Full brief (verbatim — follow ALL of it)\n\n' + fullBrief
    : desc;
  const base = { title: shortTitle, description: fullDesc };
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

/* ---------------- in-character meeting speech (v4) ----------------
   Reads each agent's AGENTS.md from Paperclip's data dir and asks the
   LLM (MiniMax via Anthropic-compatible API) for one in-character line. */
const LLM_BASE  = process.env.ANTHROPIC_BASE_URL || '';
const LLM_KEY   = process.env.ANTHROPIC_AUTH_TOKEN || '';
const LLM_MODEL = process.env.ANTHROPIC_MODEL || 'MiniMax-M2.7';
const personas = new Map();
let personasLoaded = false;
async function loadPersonas() {
  if (personasLoaded) return;
  try {
    if (!companyCache) companyCache = await getCompany();
    const cid = companyCache.id || companyCache.companyId;
    if (!agentsCache || !agentsCache.length) agentsCache = await getAgents(cid);
    for (const a of agentsCache) {
      const p = PAPERCLIP_DIR + '/instances/default/companies/' + cid +
        '/agents/' + (a.id || a.agentId) + '/instructions/AGENTS.md';
      try { personas.set(a.name, fs.readFileSync(p, 'utf8').slice(0, 1800));
        console.log('[persona] loaded ' + a.name); } catch {}
    }
    personasLoaded = true;
    console.log('[persona] ' + personas.size + ' persona file(s) found');
  } catch (e) { console.log('[persona] ' + e.message); }
}
async function characterLine(agent, topic) {
  await loadPersonas();
  const soul = personas.get(agent) || '';
  const sys = 'You are ' + agent + ', an AI employee of OIB Media, speaking ONE short line ' +
    '(max 30 words) out loud in a team standup. Stay in character, be conversational, a little ' +
    'witty, never use markdown, lists, or stage directions.' +
    (soul ? '\n\nYour role instructions (use their tone and personality):\n' + soul : '');
  const r = await fetch(LLM_BASE + '/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01',
      authorization: 'Bearer ' + LLM_KEY },
    body: JSON.stringify({ model: LLM_MODEL, max_tokens: 200, system: sys,
      messages: [{ role: 'user', content: topic }] }) });
  if (!r.ok) throw new Error('LLM ' + r.status);
  const j = await r.json();
  const text = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join(' ').trim();
  if (!text) throw new Error('empty LLM reply');
  return text.slice(0, 400);
}

async function handleClientMessage(ws, raw) {
  let m; try { m = JSON.parse(raw); } catch { return; }
  if (m && m.cmd === 'say' && m.agent) {
    const agent = String(m.agent), topic = String(m.topic || 'Give a quick status update.').slice(0, 400);
    if (!LLM_BASE || !LLM_KEY) { try { ws.send(JSON.stringify({ type: 'speech', agent, text: '', error: 'no LLM configured' })); } catch {} return; }
    try { const text = await characterLine(agent, topic);
      ws.send(JSON.stringify({ type: 'speech', agent, text }));
      console.log('[say] ' + agent + ': ' + text.slice(0, 80));
    } catch (e) { console.log('[say] ' + e.message);
      try { ws.send(JSON.stringify({ type: 'speech', agent, text: '', error: e.message })); } catch {} }
    return;
  }
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
  if (filePath.includes('.claude')) return;   // session/log noise, not task state
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

/* ---------------- LIVE STATE POLLING (v3) ----------------
   Polls Paperclip's issues API and broadcasts real agent states:
   activeRun/in_progress -> working, blocked -> blocked,
   in_review -> communicating, transition to done -> done (sleep). */
const POLL_MS = parseInt(process.env.POLL_MS || '4000', 10);
const issueStatus = new Map();   // issueId -> last seen status
const agentLive = new Map();     // agentName -> {st, msg}
const lbl = is => ((is.identifier ? is.identifier + ' — ' : '') + (is.title || '')).slice(0, 90);
async function pollLiveState() {
  try {
    if (!companyCache) companyCache = await getCompany();
    const cid = companyCache.id || companyCache.companyId || companyCache.slug;
    if (!agentsCache || !agentsCache.length) agentsCache = await getAgents(cid);
    const r = await pcFetch('/api/companies/' + cid + '/issues');
    if (!r.ok) { if (r.status === 401) await login(); return; }
    const j = await r.json();
    const arr = Array.isArray(j) ? j : (j.issues || j.data || []);
    const idToName = new Map(agentsCache.map(a => [a.id || a.agentId, a.name]));
    const buckets = new Map();   // name -> {run, prog, blocked, review}
    for (const is of arr) {
      const prev = issueStatus.get(is.id);
      issueStatus.set(is.id, is.status);
      const name = idToName.get(is.assigneeAgentId);
      if (!name) continue;
      if (prev && prev !== is.status && is.status === 'done') {
        broadcast({ agent: name, state: 'done', message: lbl(is) });
        agentLive.set(name, { st: 'done', msg: lbl(is) });
      }
      const b = buckets.get(name) || {};
      if (is.activeRun) b.run = is;
      else if (is.status === 'in_progress') b.prog = b.prog || is;
      else if (is.status === 'blocked') b.blocked = b.blocked || is;
      else if (is.status === 'in_review') b.review = b.review || is;
      buckets.set(name, b);
    }
    for (const a of agentsCache) {
      const name = a.name;
      const b = buckets.get(name) || {};
      let st = 'idle', msg;
      if (b.run) { st = 'working'; msg = lbl(b.run); }
      else if (b.prog) { st = 'working'; msg = lbl(b.prog); }
      else if (b.blocked) { st = 'blocked'; msg = lbl(b.blocked); }
      else if (b.review) { st = 'communicating'; msg = 'waiting for review: ' + lbl(b.review); }
      const prev = agentLive.get(name);
      if (prev && prev.st === 'done' && st === 'idle') continue;     // let them sleep
      if (!prev && st === 'idle') { agentLive.set(name, { st, msg }); continue; }  // no idle spam at boot
      if (!prev || prev.st !== st || (st === 'working' && msg !== prev.msg)) {
        agentLive.set(name, { st, msg });
        broadcast({ agent: name, state: st, message: msg });
      }
    }
  } catch (e) { console.log('[poll] ' + e.message); }
}
if (API && EMAIL && PASS) {
  setInterval(pollLiveState, POLL_MS);
  setTimeout(pollLiveState, 2500);
  console.log('[bridge] live state polling every ' + POLL_MS + 'ms');
}
console.log('[bridge] Watching', PAPERCLIP_DIR);
console.log('[bridge] WebSocket on port ' + PORT + (KEY ? '  (key required)' : '  (NO KEY)'));
console.log('[bridge] Assignments: ' + (API && EMAIL ? 'ENABLED -> ' + API : 'disabled (set PAPERCLIP_API/EMAIL/PASSWORD)'));
