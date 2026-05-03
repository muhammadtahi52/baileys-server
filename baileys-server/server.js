/**
 * GroupFlow — Baileys REST backend (improved)
 *
 * Endpoints (all require Authorization: Bearer <API_TOKEN>):
 *   GET  /health
 *   GET  /status        -> { status, phone? }
 *   GET  /qr            -> { qr } (data:image/png;base64,...)
 *   POST /logout        -> { ok: true }
 *   GET  /groups        -> { groups: [{ id, name, participants }] }
 *   POST /add-contact   -> { ok, message? }
 *   POST /send-invite   -> { ok, invited?, message? }
 */

const express = require("express");
const cors = require("cors");
const QRCode = require("qrcode");
const pino = require("pino");
const fs = require("fs");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
} = require("@whiskeysockets/baileys");

const PORT = process.env.PORT || 8080;
const API_TOKEN = process.env.API_TOKEN || "change-me";
const CORS_ORIGINS = (process.env.CORS_ORIGINS || "*")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const AUTH_DIR = process.env.AUTH_DIR || "auth_info";
const QR_TTL_MS = 60_000;          // QR valid ~60s before regen
const RECONNECT_BASE_MS = 3_000;   // exponential backoff base

const logger = pino({ level: process.env.LOG_LEVEL || "warn" });

// ---------- WhatsApp socket state ----------
let sock = null;
let connStatus = "disconnected"; // disconnected | qr | connecting | connected
let lastQrDataUrl = null;
let lastQrAt = 0;
let myPhone = null;
let starting = false;
let reconnectAttempts = 0;

async function startSock() {
  if (starting) return;
  starting = true;
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger,
      browser: Browsers.macOS("Desktop"),
      syncFullHistory: false,
      markOnlineOnConnect: false,
      connectTimeoutMs: 60_000,
      defaultQueryTimeoutMs: 60_000,
      keepAliveIntervalMs: 25_000,
      qrTimeout: QR_TTL_MS,
      generateHighQualityLinkPreview: false,
    });

    connStatus = "connecting";

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (u) => {
      const { connection, lastDisconnect, qr } = u;

      if (qr) {
        connStatus = "qr";
        try {
          lastQrDataUrl = await QRCode.toDataURL(qr, {
            margin: 1,
            width: 360,
            errorCorrectionLevel: "L",
          });
          lastQrAt = Date.now();
          console.log("📱 New QR generated (valid ~60s)");
        } catch (e) {
          console.error("QR encode failed:", e.message);
          lastQrDataUrl = null;
        }
      }

      if (connection === "open") {
        connStatus = "connected";
        lastQrDataUrl = null;
        lastQrAt = 0;
        reconnectAttempts = 0;
        myPhone = sock?.user?.id?.split(":")[0]?.split("@")[0] || null;
        console.log("✅ WhatsApp connected as", myPhone);
      }

      if (connection === "close") {
        const code = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        console.log(`❌ Connection closed. code=${code} loggedOut=${loggedOut}`);
        connStatus = "disconnected";
        myPhone = null;

        if (loggedOut) {
          try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch {}
        }

        const delay = Math.min(60_000, RECONNECT_BASE_MS * 2 ** reconnectAttempts);
        reconnectAttempts++;
        console.log(`↻ Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
        setTimeout(() => { starting = false; startSock(); }, delay);
        return;
      }
    });
  } catch (e) {
    console.error("startSock failed:", e);
    setTimeout(() => { starting = false; startSock(); }, 5_000);
    return;
  } finally {
    // allow re-entry only after connection event resolves
    setTimeout(() => { starting = false; }, 1_000);
  }
}

startSock();

// ---------- Helpers ----------
function jid(phone) {
  const digits = String(phone).replace(/\D/g, "");
  if (digits.length < 6) throw new Error("Invalid phone number");
  return `${digits}@s.whatsapp.net`;
}

function ensureConnected(res) {
  if (connStatus !== "connected" || !sock) {
    res.status(409).json({ ok: false, message: "WhatsApp not connected" });
    return false;
  }
  return true;
}

// ---------- Express ----------
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use(
  cors({
    origin: CORS_ORIGINS.includes("*") ? true : CORS_ORIGINS,
    credentials: false,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// Auth middleware
app.use((req, res, next) => {
  if (req.method === "OPTIONS") return next();
  if (req.path === "/health") return next();
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!API_TOKEN || token !== API_TOKEN) {
    return res.status(401).json({ ok: false, message: "Unauthorized" });
  }
  next();
});

app.get("/health", (_req, res) => res.json({ ok: true, status: connStatus }));

app.get("/status", (_req, res) => {
  res.json({ status: connStatus, phone: myPhone || undefined });
});

app.get("/qr", (_req, res) => {
  if (connStatus === "connected") return res.json({ qr: "" });

  // If QR is stale (>60s) clear it so frontend keeps polling for a fresh one
  if (lastQrDataUrl && Date.now() - lastQrAt > QR_TTL_MS) {
    lastQrDataUrl = null;
  }

  if (!lastQrDataUrl) {
    if (!sock && !starting) startSock();
    return res.status(202).json({ qr: "", message: "Generating QR…" });
  }
  res.json({ qr: lastQrDataUrl });
});

app.post("/logout", async (_req, res) => {
  try { if (sock) await sock.logout().catch(() => {}); } catch {}
  connStatus = "disconnected";
  myPhone = null;
  lastQrDataUrl = null;
  lastQrAt = 0;
  reconnectAttempts = 0;
  try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch {}
  setTimeout(() => { starting = false; startSock(); }, 500);
  res.json({ ok: true });
});

app.get("/groups", async (_req, res) => {
  if (!ensureConnected(res)) return;
  try {
    const all = await sock.groupFetchAllParticipating();
    const groups = Object.values(all)
      .map((g) => ({
        id: g.id,
        name: g.subject || "(no name)",
        participants: g.participants?.length ?? 0,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ groups });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

app.post("/add-contact", async (req, res) => {
  if (!ensureConnected(res)) return;
  const { groupId, phone } = req.body || {};
  if (!groupId || !phone) {
    return res.status(400).json({ ok: false, message: "groupId and phone required" });
  }
  try {
    const target = jid(phone);
    const [exists] = await sock.onWhatsApp(target);
    if (!exists?.exists) {
      return res.json({ ok: false, message: "Number not on WhatsApp" });
    }

    // Skip if already a member
    try {
      const meta = await sock.groupMetadata(groupId);
      if (meta.participants?.some((p) => p.id === target || p.id === exists.jid)) {
        return res.json({ ok: true, message: "Already in group" });
      }
    } catch {}

    const result = await sock.groupParticipantsUpdate(groupId, [exists.jid || target], "add");
    const r = result?.[0];
    const status = String(r?.status || "");
    if (status === "200") return res.json({ ok: true, message: "Added directly" });
    if (status === "409") return res.json({ ok: true, message: "Already in group" });
    if (status === "403") return res.json({ ok: false, message: "Privacy settings — invite required" });
    if (status === "408") return res.json({ ok: false, message: "Recently left — invite required" });
    if (status === "401") return res.json({ ok: false, message: "Not admin of this group" });
    return res.json({ ok: false, message: `Add failed (${status || "unknown"})` });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

app.post("/send-invite", async (req, res) => {
  if (!ensureConnected(res)) return;
  const { groupId, phone } = req.body || {};
  if (!groupId || !phone) {
    return res.status(400).json({ ok: false, message: "groupId and phone required" });
  }
  try {
    const target = jid(phone);
    const [exists] = await sock.onWhatsApp(target);
    if (!exists?.exists) {
      return res.json({ ok: false, message: "Number not on WhatsApp" });
    }
    const code = await sock.groupInviteCode(groupId);
    const link = `https://chat.whatsapp.com/${code}`;
    await sock.sendMessage(exists.jid || target, {
      text: `You're invited to join our group:\n${link}`,
    });
    res.json({ ok: true, invited: true, message: "Invite sent" });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// Global error guard
app.use((err, _req, res, _next) => {
  console.error("Unhandled:", err);
  res.status(500).json({ ok: false, message: err.message || "Server error" });
});

process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));
process.on("uncaughtException", (e) => console.error("uncaughtException:", e));

app.listen(PORT, () => {
  console.log(`🚀 Baileys server listening on :${PORT}`);
  console.log(`   API_TOKEN length: ${API_TOKEN.length}`);
  console.log(`   CORS_ORIGINS: ${CORS_ORIGINS.join(", ")}`);
});
