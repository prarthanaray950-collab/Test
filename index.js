require("dotenv").config();

const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidGroup,
} = require("@whiskeysockets/baileys");

const { useMongoAuthState } = require("./db/mongoAuthState");
const connectDB              = require("./db/connect");
const { handleMessage }      = require("./bot/messageHandler");
const admin                  = require("./bot/adminNotifier");

const express  = require("express");
const qrcode   = require("qrcode");
const pino     = require("pino");

// ── Express server (serves QR page + health check) ───────────────────────────
const app = express();
app.use(express.json());

let currentQR  = null;
let botStatus  = "starting";

app.get("/", (_, res) => {
  res.send(`<!DOCTYPE html><html><head>
    <title>SatvikMeals Bot</title>
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <style>
      body{font-family:sans-serif;text-align:center;padding:30px;background:#f0fdf4}
      h1{color:#16a34a}
      img{max-width:280px;border:2px solid #16a34a;border-radius:12px;margin-top:16px}
      .btn{display:inline-block;margin-top:16px;padding:10px 24px;background:#16a34a;color:#fff;border-radius:8px;text-decoration:none;font-weight:bold}
    </style>
    <script>setTimeout(()=>{if("${botStatus}"!=="ready")location.reload();},5000);</script>
  </head><body>
    <h1>🌿 SatvikMeals Bot</h1>
    <p>Status: <strong>${botStatus}</strong></p>
    ${botStatus === "qr_ready" && currentQR
      ? `<p>📱 Scan with WhatsApp → Linked Devices → Link a Device:</p>
         <img src="${currentQR}" alt="QR"/>`
      : botStatus === "ready"
      ? `<p style="color:#16a34a;font-size:1.4em">✅ Bot is LIVE!</p>`
      : `<p>⏳ Starting... page refreshes automatically.</p>`}
    <br><a class="btn" href="/health">Health Check</a>
  </body></html>`);
});

app.get("/health", (_, res) => res.json({ status: "ok", botStatus, uptime: process.uptime(), time: new Date() }));
app.get("/status", (_, res) => res.json({ botStatus }));

app.get("/api/clear-session", async (_, res) => {
  try {
    const mongoose = require("mongoose");
    const AuthModel = mongoose.models.BaileysAuth;
    if (AuthModel) {
      await AuthModel.deleteMany({});
      currentQR = null;
      botStatus  = "starting";
      console.log("[Session] ✅ Session cleared from MongoDB. Restart to get a fresh QR.");
      res.json({ ok: true, message: "Session cleared. Restart the service to get a new QR code." });
    } else {
      res.json({ ok: false, message: "AuthModel not ready yet." });
    }
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[Server] Running on port ${PORT}`));

// ── Crash protection ─────────────────────────────────────────────────────────
process.on("unhandledRejection", (r) => console.error("[UnhandledRejection]", r));
process.on("uncaughtException",  (e) => console.error("[UncaughtException]", e.message));

// ── Bot ──────────────────────────────────────────────────────────────────────
let isConnecting = false;

const startBot = async () => {
  if (isConnecting) return;
  isConnecting = true;

  try {
    await connectDB();

    const { state, saveCreds } = await useMongoAuthState();
    const { version } = await fetchLatestBaileysVersion();
    console.log(`[Baileys] Using WA version: ${version.join(".")}`);

    const sock = makeWASocket({
      version,
      auth: state,
      // Silent logger — only errors show in Render logs
      logger: pino({ level: "error" }),
      printQRInTerminal: false,
      browser: ["SatvikMeals Bot", "Chrome", "1.0.0"],
      connectTimeoutMs: 60_000,
      keepAliveIntervalMs: 30_000,
      retryRequestDelayMs: 2000,
    });

    // ── Save credentials whenever they update ──
    sock.ev.on("creds.update", async () => {
      await saveCreds();
    });

    // ── Connection events ──
    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      // New QR code received — render as image
      if (qr) {
        try {
          currentQR  = await qrcode.toDataURL(qr, { width: 300, margin: 2 });
          botStatus  = "qr_ready";
          console.log("[QR] ✅ QR ready! Open your Render URL in browser and scan.");
        } catch (e) {
          console.error("[QR] Failed to generate image:", e.message);
        }
      }

      if (connection === "close") {
        currentQR = null;
        const code = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = code !== DisconnectReason.loggedOut;

        console.log(`[Baileys] Connection closed. Code: ${code}. Reconnect: ${shouldReconnect}`);

        if (shouldReconnect) {
          botStatus    = "reconnecting";
          isConnecting = false;
          console.log("[Baileys] Reconnecting in 10s...");
          setTimeout(startBot, 10_000);
        } else {
          // Logged out — clear session so fresh QR is shown
          botStatus = "logged_out";
          console.log("[Baileys] Logged out. Clear session and restart.");
        }
      }

      if (connection === "open") {
        botStatus  = "ready";
        currentQR  = null;
        isConnecting = false;
        console.log("[Baileys] ✅ Connected to WhatsApp!");
        admin.setSocket(sock);
        await admin.notify("🤖 SatvikMeals Bot ONLINE! 🌿\nBaileys se connected — no Chrome needed!\nSession MongoDB mein save hai.");
      }
    });

    // ── Incoming messages ──
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;

      for (const msg of messages) {
        // Skip own messages
        if (msg.key.fromMe) continue;

        // Skip group messages
        const jid = msg.key.remoteJid;
        if (!jid || isJidGroup(jid)) continue;

        // Skip status broadcast
        if (jid === "status@broadcast") continue;

        // Get message text
        const text =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          "";

        if (!text.trim()) continue;

        // Handle the message
        await handleMessage(sock, jid, text.trim());
      }
    });

  } catch (err) {
    console.error("[Bot] startBot error:", err.message);
    isConnecting = false;
    console.log("[Bot] Retrying in 15s...");
    setTimeout(startBot, 15_000);
  }
};

startBot();
