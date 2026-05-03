/**
 * GroupFlow — Stable Baileys REST backend (FIXED)
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
} = require("@whiskeysockets/baileys");

const PORT = process.env.PORT || 8080;
const API_TOKEN = process.env.API_TOKEN || "change-me";
const CORS_ORIGINS = (process.env.CORS_ORIGINS || "*")
  .split(",")
  .map(s => s.trim());

const logger = pino({ level: "silent" });

// ---------------- STATE ----------------
let sock = null;
let connStatus = "disconnected";
let lastQrDataUrl = null;
let myPhone = null;

let reconnectAttempts = 0;
const MAX_RECONNECT = 5;

// ---------------- SOCK ----------------
async function startSock() {
  try {
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

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        connStatus = "qr";
        try {
          lastQrDataUrl = await QRCode.toDataURL(qr);
        } catch {
          lastQrDataUrl = null;
        }
      }

      if (connection === "open") {
        connStatus = "connected";
        reconnectAttempts = 0;
        lastQrDataUrl = null;
        myPhone = sock?.user?.id?.split(":")[0] || null;

        console.log("✅ Connected:", myPhone);
      }

      if (connection === "close") {
        const code = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;

        console.log("❌ Closed code:", code, "loggedOut:", loggedOut);

        connStatus = "disconnected";
        myPhone = null;

        if (loggedOut) {
          safeDeleteAuth();
          return;
        }

        if (reconnectAttempts < MAX_RECONNECT) {
          reconnectAttempts++;
          console.log(`🔁 Reconnect attempt ${reconnectAttempts}`);

          setTimeout(() => {
            startSock();
          }, 10000); // ✅ FIX: slow reconnect (IMPORTANT)
        } else {
          console.log("❌ Max reconnect reached");
        }
      }
    });

  } catch (err) {
    console.error("startSock error:", err);
  }
}

// ---------------- CLEAN AUTH ----------------
function safeDeleteAuth() {
  try {
    fs.rmSync("auth_info", { recursive: true, force: true });
    console.log("🧹 Auth cleared");
  } catch {}
}

// ---------------- START ----------------
startSock();

// ---------------- HELPERS ----------------
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

// ---------------- APP ----------------
const app = express();
app.use(express.json({ limit: "1mb" }));

app.use(cors({
  origin: CORS_ORIGINS.includes("*") ? true : CORS_ORIGINS,
}));

// AUTH
app.use((req, res, next) => {
  if (req.path === "/health") return next();

  const token = (req.headers.authorization || "").replace("Bearer ", "");

  if (token !== API_TOKEN) {
    return res.status(401).json({ ok: false, message: "Unauthorized" });
  }
  next();
});

// ---------------- ROUTES ----------------
app.get("/health", (_, res) => {
  res.json({ ok: true });
});

app.get("/status", (_, res) => {
  res.json({ status: connStatus, phone: myPhone || null });
});

app.get("/qr", async (_, res) => {
  if (connStatus === "connected") {
    return res.json({ qr: null });
  }

  if (!lastQrDataUrl) {
    return res.status(202).json({ qr: null });
  }

  res.json({ qr: lastQrDataUrl });
});

app.post("/logout", async (_, res) => {
  try {
    await sock?.logout?.();
  } catch {}

  connStatus = "disconnected";
  myPhone = null;
  lastQrDataUrl = null;

  safeDeleteAuth();

  setTimeout(startSock, 2000);

  res.json({ ok: true });
});

// ---------------- GROUPS ----------------
app.get("/groups", async (req, res) => {
  if (!(await ensureConnected(res))) return;

  try {
    const all = await sock.groupFetchAllParticipating();

    const groups = Object.values(all).map(g => ({
      id: g.id,
      name: g.subject,
      participants: g.participants?.length || 0,
    }));

    res.json({ groups });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ---------------- ADD CONTACT ----------------
app.post("/add-contact", async (req, res) => {
  if (!(await ensureConnected(res))) return;

  const { groupId, phone } = req.body || {};

  if (!groupId || !phone) {
    return res.status(400).json({ ok: false });
  }

  try {
    const target = jid(phone);
    const [exists] = await sock.onWhatsApp(target);

    if (!exists?.exists) {
      return res.json({ ok: false, message: "Not on WhatsApp" });
    }

    const result = await sock.groupParticipantsUpdate(
      groupId,
      [target],
      "add"
    );

    const r = result?.[0];

    res.json({
      ok: true,
      status: r?.status,
    });

  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ---------------- INVITE ----------------
app.post("/send-invite", async (req, res) => {
  if (!(await ensureConnected(res))) return;

  const { groupId, phone } = req.body || {};

  try {
    const code = await sock.groupInviteCode(groupId);
    const link = `https://chat.whatsapp.com/${code}`;

    const target = jid(phone);

    await sock.sendMessage(target, {
      text: `Join group:\n${link}`,
    });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ---------------- START SERVER ----------------
app.listen(PORT, () => {
  console.log("🚀 Server running on", PORT);
  console.log("🔐 Token length:", API_TOKEN.length);
});
