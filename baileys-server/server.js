/**
 * GroupFlow — Baileys REST backend
 *
 * Implements the contract expected by the dashboard:
 *   GET  /status         -> { status, phone? }
 *   GET  /qr             -> { qr }   (data:image/png;base64,...)
 *   POST /logout         -> { ok: true }
 *   GET  /groups         -> { groups: [{ id, name, participants }] }
 *   POST /add-contact    -> { ok, message? }
 *   POST /send-invite    -> { ok, invited?, message? }
 *
 * Auth: every request must send  Authorization: Bearer <API_TOKEN>
 *
 * ⚠️ Disclaimer: Baileys uses an unofficial WhatsApp Web protocol.
 * Bulk-adding strangers to groups can get your number banned.
 * Use a burner number, keep delays high (>=30s), and warm the account up.
 */

const express = require("express");
const cors = require("cors");
const QRCode = require("qrcode");
const pino = require("pino");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");

const PORT = process.env.PORT || 8080;
const API_TOKEN = process.env.API_TOKEN || "change-me";
const CORS_ORIGINS = (process.env.CORS_ORIGINS || "*")
  .split(",")
  .map((s) => s.trim());

const logger = pino({ level: "warn" });

// ---------- WhatsApp socket state ----------
let sock = null;
let connStatus = "disconnected"; // disconnected | qr | connecting | connected
let lastQrDataUrl = null;
let myPhone = null;

async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info");
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger,
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  connStatus = "connecting";

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      connStatus = "qr";
      try {
        lastQrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
      } catch (e) {
        lastQrDataUrl = null;
      }
    }
    if (connection === "open") {
      connStatus = "connected";
      lastQrDataUrl = null;
      myPhone = sock?.user?.id?.split(":")[0] || null;
      console.log("✅ WhatsApp connected as", myPhone);
    }
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      console.log("❌ Connection closed. code=", code, "loggedOut=", loggedOut);
      connStatus = "disconnected";
      myPhone = null;
      if (!loggedOut) {
        setTimeout(startSock, 2000);
      }
    }
  });
}

startSock().catch((e) => console.error("startSock failed:", e));

// ---------- Helpers ----------
function jid(phone) {
  const digits = String(phone).replace(/\D/g, "");
  return `${digits}@s.whatsapp.net`;
}

async function ensureConnected(res) {
  if (connStatus !== "connected" || !sock) {
    res.status(409).json({ ok: false, message: "WhatsApp not connected" });
    return false;
  }
  return true;
}

// ---------- Express ----------
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(
  cors({
    origin: CORS_ORIGINS.includes("*") ? true : CORS_ORIGINS,
    credentials: false,
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

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/status", (_req, res) => {
  res.json({ status: connStatus, phone: myPhone || undefined });
});

app.get("/qr", (_req, res) => {
  if (connStatus === "connected") {
    return res.json({ qr: "" });
  }
  if (!lastQrDataUrl) {
    // Trigger a fresh socket if needed
    if (!sock) startSock().catch(() => {});
    return res.status(202).json({ qr: "" });
  }
  res.json({ qr: lastQrDataUrl });
});

app.post("/logout", async (_req, res) => {
  try {
    if (sock) await sock.logout().catch(() => {});
  } catch {}
  connStatus = "disconnected";
  myPhone = null;
  lastQrDataUrl = null;
  // wipe creds so next /qr issues a new pairing
  try {
    const fs = require("fs");
    fs.rmSync("auth_info", { recursive: true, force: true });
  } catch {}
  setTimeout(startSock, 500);
  res.json({ ok: true });
});

app.get("/groups", async (_req, res) => {
  if (!(await ensureConnected(res))) return;
  try {
    const all = await sock.groupFetchAllParticipating();
    const groups = Object.values(all).map((g) => ({
      id: g.id,
      name: g.subject,
      participants: g.participants?.length ?? 0,
    }));
    res.json({ groups });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

app.post("/add-contact", async (req, res) => {
  if (!(await ensureConnected(res))) return;
  const { groupId, phone } = req.body || {};
  if (!groupId || !phone) {
    return res.status(400).json({ ok: false, message: "groupId and phone required" });
  }
  try {
    const target = jid(phone);
    // Check if number is on WhatsApp
    const [exists] = await sock.onWhatsApp(target);
    if (!exists?.exists) {
      return res.json({ ok: false, message: "Number not on WhatsApp" });
    }

    const result = await sock.groupParticipantsUpdate(groupId, [target], "add");
    const r = result?.[0];
    if (r?.status === "200") {
      return res.json({ ok: true, message: "Added directly" });
    }
    // 403 = privacy settings; 408 = needs invite; 409 = already in group
    if (r?.status === "409") {
      return res.json({ ok: true, message: "Already in group" });
    }
    return res.json({
      ok: false,
      message: `Add failed (${r?.status || "unknown"}) — invite required`,
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

app.post("/send-invite", async (req, res) => {
  if (!(await ensureConnected(res))) return;
  const { groupId, phone } = req.body || {};
  if (!groupId || !phone) {
    return res.status(400).json({ ok: false, message: "groupId and phone required" });
  }
  try {
    const code = await sock.groupInviteCode(groupId);
    const link = `https://chat.whatsapp.com/${code}`;
    const target = jid(phone);
    const [exists] = await sock.onWhatsApp(target);
    if (!exists?.exists) {
      return res.json({ ok: false, message: "Number not on WhatsApp" });
    }
    await sock.sendMessage(target, {
      text: `You're invited to join our group:\n${link}`,
    });
    res.json({ ok: true, invited: true, message: "Invite sent" });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Baileys server listening on :${PORT}`);
  console.log(`   API_TOKEN length: ${API_TOKEN.length}`);
});
