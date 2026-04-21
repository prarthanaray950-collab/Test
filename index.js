require("dotenv").config();

const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidGroup,
} = require("@whiskeysockets/baileys");

const { useMongoAuthState } = require("./db/mongoAuthState");
const connectDB             = require("./db/connect");
const { handleMessage }     = require("./bot/messageHandler");
const admin                 = require("./bot/adminNotifier");

const express = require("express");
const qrcode  = require("qrcode");
const pino    = require("pino");

const app = express();
app.use(express.json());

let currentQR = null;
let botStatus = "starting";

app.get("/", (_, res) => {
  res.send(`<!DOCTYPE html><html><head>
    <title>SatvikMeals Bot</title>
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <style>
      *{box-sizing:border-box;margin:0;padding:0}
      body{font-family:sans-serif;text-align:center;padding:40px 20px;background:#f0fdf4;min-height:100vh}
      h1{color:#16a34a;font-size:1.8em;margin-bottom:8px}
      .sub{color:#4b5563;margin-bottom:24px}
      .status{display:inline-block;padding:6px 16px;border-radius:999px;font-weight:600;margin-bottom:20px}
      .status.ready{background:#dcfce7;color:#16a34a}
      .status.qr_ready{background:#fef9c3;color:#854d0e}
      .status.reconnecting{background:#fee2e2;color:#991b1b}
      .status.starting{background:#e0e7ff;color:#3730a3}
      img{max-width:280px;border:3px solid #16a34a;border-radius:16px;margin:16px auto;display:block}
      .btn{display:inline-block;margin:8px;padding:10px 22px;background:#16a34a;color:#fff;border-radius:8px;text-decoration:none;font-weight:bold}
      .btn.sec{background:#6b7280}
    </style>
    <script>setTimeout(()=>{if("${botStatus}"!=="ready")location.reload();},6000);</script>
  </head><body>
    <h1>🌿 SatvikMeals Bot</h1>
    <p class="sub">WhatsApp AI Assistant</p>
    <span class="status ${botStatus}">${botStatus.replace("_"," ").toUpperCase()}</span>
    ${botStatus === "qr_ready" && currentQR
      ? `<p>📱 Open WhatsApp → Linked Devices → Link a Device</p><img src="${currentQR}" alt="Scan QR"/>`
      : botStatus === "ready"
      ? `<p style="color:#16a34a;font-size:1.3em;margin-top:8px">✅ Bot is LIVE!</p>`
      : `<p style="color:#6b7280">⏳ Please wait — page auto-refreshes...</p>`}
    <br>
    <a class="btn" href="/health">Health Check</a>
    <a class="btn sec" href="/api/clear-session">Clear Session</a>
  </body></html>`);
});

app.get("/health", (_, res) =>
  res.json({ status: "ok", botStatus, uptime: Math.floor(process.uptime()), time: new Date() })
);
app.get("/status", (_, res) => res.json({ botStatus }));

app.get("/api/clear-session", async (_, res) => {
  try {
    const mongoose = require("mongoose");
    const AuthModel = mongoose.models.BaileysAuth;
    if (AuthModel) {
      await AuthModel.deleteMany({});
      currentQR = null;
      botStatus = "starting";
      res.json({ ok: true, message: "Session cleared. Restart the service for a new QR." });
    } else {
      res.json({ ok: false, message: "AuthModel not ready yet." });
    }
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[Server] Running on port ${PORT}`));

process.on("unhandledRejection", (r) => console.error("[UnhandledRejection]", r));
process.on("uncaughtException",  (e) => console.error("[UncaughtException]", e.message));

let isConnecting = false;

const startBot = async () => {
  if (isConnecting) return;
  isConnecting = true;

  try {
    await connectDB();

    const { state, saveCreds } = await useMongoAuthState();
    const { version }          = await fetchLatestBaileysVersion();
    console.log(`[Baileys] WA version: ${version.join(".")}`);

    const sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: "error" }),
      printQRInTerminal: false,
      browser: ["SatvikMeals Bot", "Chrome", "1.0.0"],
      connectTimeoutMs:    60_000,
      keepAliveIntervalMs: 30_000,
      retryRequestDelayMs: 2_000,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          currentQR = await qrcode.toDataURL(qr, { width: 300, margin: 2 });
          botStatus = "qr_ready";
          console.log("[QR] ✅ Ready — open your Render URL and scan.");
        } catch (e) {
          console.error("[QR] Failed:", e.message);
        }
      }

      if (connection === "close") {
        currentQR = null;
        const code = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = code !== DisconnectReason.loggedOut;
        console.log(`[Baileys] Closed. Code: ${code}. Reconnect: ${shouldReconnect}`);
        if (shouldReconnect) {
          botStatus    = "reconnecting";
          isConnecting = false;
          setTimeout(startBot, 10_000);
        } else {
          botStatus = "logged_out";
        }
      }

      if (connection === "open") {
        botStatus    = "ready";
        currentQR    = null;
        isConnecting = false;
        console.log("[Baileys] ✅ Connected to WhatsApp!");
        admin.setSocket(sock);
        await admin.notifyBotOnline();
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;
      for (const msg of messages) {
        if (msg.key.fromMe) continue;
        const jid = msg.key.remoteJid;
        if (!jid || isJidGroup(jid)) continue;
        if (jid === "status@broadcast") continue;

        const text =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          msg.message?.buttonsResponseMessage?.selectedButtonId ||
          msg.message?.listResponseMessage?.singleSelectReply?.selectedRowId ||
          "";

        if (!text.trim()) continue;

        handleMessage(sock, jid, text.trim()).catch((e) =>
          console.error(`[MsgErr] ${jid}: ${e.message}`)
        );
      }
    });

  } catch (err) {
    console.error("[Bot] startBot error:", err.message);
    isConnecting = false;
    setTimeout(startBot, 15_000);
  }
};

startBot();
