# GroupFlow — Baileys Backend

A Node.js REST server that gives your **GroupFlow dashboard** a real WhatsApp connection via [Baileys](https://github.com/WhiskeySockets/Baileys).

> ⚠️ Baileys uses an **unofficial** WhatsApp Web protocol. Bulk-adding contacts can get your number **banned**. Use a burner number, keep the delay ≥ 30s, and warm the account up before going hard.

---

## 1. What it gives you

A server URL like `https://your-app.onrender.com` that exposes:

| Method | Path            | Purpose                             |
| ------ | --------------- | ----------------------------------- |
| GET    | `/status`       | connection state + your phone       |
| GET    | `/qr`           | base64 PNG QR for first-time login  |
| POST   | `/logout`       | disconnect & wipe session           |
| GET    | `/groups`       | list groups you're in               |
| POST   | `/add-contact`  | `{ groupId, phone }` → add directly |
| POST   | `/send-invite`  | `{ groupId, phone }` → DM invite link |

All requests require:
```
Authorization: Bearer <API_TOKEN>
```

---

## 2. Run locally (fastest test)

```bash
cd baileys-server
npm install
cp .env.example .env       # edit API_TOKEN
node server.js
```

Then in your dashboard → **Settings**:
- Turn **Demo Mode** OFF
- Backend URL: `http://localhost:8080`
- API Token: whatever you put in `.env`
- Click **Connect WhatsApp** → scan QR with phone

---

## 3. Deploy to the cloud (recommended hosts)

Baileys needs a **persistent Node process** (not edge/serverless). Pick one:

### Option A — Render.com (free tier works)
1. Push this folder to a new GitHub repo.
2. Render → **New → Web Service** → connect repo.
3. Runtime: **Node**. Build: `npm install`. Start: `node server.js`.
4. Add env vars: `API_TOKEN`, `CORS_ORIGINS` (your Lovable URL).
5. Deploy. Your URL = `https://<name>.onrender.com`.
6. **Important**: add a Render **Disk** (1 GB is enough) mounted at `/app/auth_info` so your WhatsApp session survives restarts.

### Option B — Railway.app
1. New project → Deploy from GitHub.
2. Add the same env vars.
3. Add a **Volume** mounted at `/app/auth_info`.
4. Public URL appears in the service settings.

### Option C — Fly.io / VPS / Docker
A `Dockerfile` is included. Mount a volume at `/app/auth_info` for persistence.

---

## 4. Wire it to GroupFlow

In the dashboard:
1. Click **Settings**
2. Toggle **Demo Mode** off
3. Paste your **Backend URL** (e.g. `https://groupflow-bot.onrender.com`)
4. Paste the same **API Token** you set on the server
5. Save → Click **Connect WhatsApp** → scan QR

That's it. Upload numbers, pick a group, hit **Start Bulk**.

---

## 5. CORS

Set `CORS_ORIGINS` to your dashboard URL(s), comma-separated:
```
CORS_ORIGINS=https://id-preview--abc123.lovable.app,https://your-app.lovable.app
```
Use `*` only while testing.

---

## 6. Troubleshooting

- **QR never appears** → wait 5–10s after first boot, then refresh.
- **Disconnects every few minutes** → your number may be flagged. Lower volume, raise interval to 60s+.
- **All adds return "invite required"** → most users restrict who can add them. The dashboard automatically falls back to invite. Working as intended.
- **Account banned** → use a fresh number, smaller batches, longer delays. There's no way to undo a ban.
