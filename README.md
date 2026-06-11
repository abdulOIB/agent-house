# OIB Media — Agent House

Live dashboard for watching Paperclip agents work, talk, panic, and sleep
in a Neighbours-from-Hell-style house. Four tabs: House, Analytics, Team
(assign tasks + real photo faces), Meeting (agents speak via browser TTS,
you can talk back with your microphone).

## Layout
- `index.html` — the whole dashboard (deployed by Vercel)
- `bridge/` — runs on the VPS next to Paperclip, streams events over WebSocket

## Deploy the dashboard (Vercel)
1. Import this repo at vercel.com → New Project → Deploy (no settings needed).
2. You get `https://<project>.vercel.app`.

## Run the bridge (on the VPS where Paperclip lives)
```bash
git clone <this-repo-url>
cd agent-house/bridge
npm install
BRIDGE_KEY=your-long-secret pm2 start paperclip-bridge-server.js --name bridge
pm2 save && pm2 startup
pm2 logs bridge     # watch for [discovery] lines
```
Env vars: `BRIDGE_KEY` (auth secret), `PAPERCLIP_DIR` (default ~/.paperclip),
`PORT` (default 8787), `AGENTS` (comma list of agent names).

## Expose the bridge as wss:// 
The dashboard is https, so the bridge needs TLS. Use your existing reverse
proxy (Traefik/Caddy/Nginx) to route `bridge.yourdomain.com` → `localhost:8787`,
with a DNS A record pointing the subdomain at the VPS IP.

## Team link
```
https://<project>.vercel.app/?ws=wss://bridge.yourdomain.com/?key=your-long-secret
```
Opens the dashboard already connected LIVE. Faces/voices are stored per-browser.

## Update flow
Edit files on GitHub (or push) → Vercel redeploys automatically.
On the VPS: `git pull && pm2 restart bridge`.
