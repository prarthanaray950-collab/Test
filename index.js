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
const scheduler             = require("./bot/scheduler");
const Conversation          = require("./db/models/Conversation");

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
      : `<p style="color:#6b7280">⏳ Please wait...</p>`}
    <br>
    <a class="btn" href="/health">Health Check</a>
    <a class="btn sec" href="/api/clear-session">Clear Session</a>
  </body></html>`);
});

app.get("/health", (_, res) => res.json({ status: "ok", botStatus, uptime: Math.floor(process.uptime()), time: new Date() }));
app.get("/status", (_, res) => res.json({ botStatus }));

app.get("/api/clear-session", async (_, res) => {
  try {
    const mongoose = require("mongoose");
    const AuthModel = mongoose.models.BaileysAuth;
    if (AuthModel) {
      await AuthModel.deleteMany({});
      currentQR = null; botStatus = "starting";
      res.json({ ok: true, message: "Session cleared." });
    } else {
      res.json({ ok: false, message: "AuthModel not ready." });
    }
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Admin HTTP endpoints ────────────────────────────────────────────────────────
app.post("/api/admin/broadcast", async (req, res) => {
  const { secret, message, phones } = req.body || {};
  if (!secret || secret !== (process.env.BOT_SECRET || "")) return res.status(401).json({ ok: false, error: "Unauthorized" });
  if (!message?.trim()) return res.status(400).json({ ok: false, error: "message required" });
  try {
    let targets = Array.isArray(phones) && phones.length ? phones : (await Conversation.find({}, { phoneNumber: 1 }).lean()).map(d => d.phoneNumber).filter(Boolean);
    res.json({ ok: true, queued: targets.length });
    const result = await admin.broadcast(targets, message.trim());
    await admin.toEventsGroup("📢 HTTP BROADCAST\n\"" + message.slice(0,80) + "\"\nSent: " + result.sent + " | Failed: " + result.failed);
  } catch (e) { console.error("[Broadcast API]", e.message); }
});

app.get("/api/admin/stats", async (req, res) => {
  const secret = req.query.secret || req.headers["x-bot-secret"];
  if (!secret || secret !== (process.env.BOT_SECRET || "")) return res.status(401).json({ ok: false, error: "Unauthorized" });
  try {
    const total      = await Conversation.countDocuments();
    const withOrders = await Conversation.countDocuments({ "profile.totalOrders": { $gt: 0 } });
    const recent     = await Conversation.find({}, { phoneNumber: 1, "profile.name": 1, updatedAt: 1 }).sort({ updatedAt: -1 }).limit(10).lean();
    res.json({ ok: true, totalCustomers: total, customersWithOrders: withOrders, recentChats: recent });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("[Server] Running on port " + PORT));

process.on("unhandledRejection", (r) => console.error("[UnhandledRejection]", r));
process.on("uncaughtException",  (e) => console.error("[UncaughtException]", e.message));

// ── Bot state ──────────────────────────────────────────────────────────────────
let isConnecting = false;
let activeSock   = null;

// Message ID deduplication
const _seenMsgIds = new Set();
const markSeen = (id) => {
  if (_seenMsgIds.size >= 500) _seenMsgIds.delete(_seenMsgIds.values().next().value);
  _seenMsgIds.add(id);
};

const startBot = async () => {
  if (isConnecting) return;
  isConnecting = true;

  if (activeSock) {
    try { activeSock.ev.removeAllListeners(); activeSock.ws?.close(); } catch (_) {}
    activeSock = null;
    console.log("[Baileys] Previous socket torn down.");
  }

  try {
    await connectDB();
    admin.setConversationModel(Conversation);

    const { state, saveCreds } = await useMongoAuthState();
    const { version }          = await fetchLatestBaileysVersion();
    console.log("[Baileys] WA version: " + version.join("."));

    const sock = makeWASocket({
      version, auth: state,
      logger: pino({ level: "error" }),
      printQRInTerminal: false,
      browser: ["SatvikMeals Bot", "Chrome", "1.0.0"],
      connectTimeoutMs: 60_000, keepAliveIntervalMs: 30_000, retryRequestDelayMs: 2_000,
    });

    activeSock = sock;
    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        try { currentQR = await qrcode.toDataURL(qr, { width: 300, margin: 2 }); botStatus = "qr_ready"; } catch (_) {}
      }
      if (connection === "close") {
        currentQR = null;
        const code = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = code !== DisconnectReason.loggedOut;
        console.log("[Baileys] Closed. Code: " + code + ". Reconnect: " + shouldReconnect);
        if (shouldReconnect) { botStatus = "reconnecting"; isConnecting = false; setTimeout(startBot, 10_000); }
        else { botStatus = "logged_out"; }
      }
      if (connection === "open") {
        botStatus = "ready"; currentQR = null; isConnecting = false;
        console.log("[Baileys] ✅ Connected to WhatsApp!");
        admin.setSocket(sock);
        scheduler.setSocket(sock);
        scheduler.start();
        await admin.notifyBotOnline();
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;

      for (const msg of messages) {
        if (msg.key.fromMe) continue;
        const jid = msg.key.remoteJid;
        if (!jid || jid === "status@broadcast") continue;

        // Extract text from all message types
        const text =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          msg.message?.videoMessage?.caption ||
          msg.message?.buttonsResponseMessage?.selectedButtonId ||
          msg.message?.listResponseMessage?.singleSelectReply?.selectedRowId ||
          "";

        // Extract media info for payment screenshots etc.
        const hasImage = !!msg.message?.imageMessage;
        const hasVideo = !!msg.message?.videoMessage;
        const pushName = msg.pushName || "";

        // ── GROUP MESSAGES ─────────────────────────────────────────────────────
        if (isJidGroup(jid)) {
          const eventsGroup = process.env.EVENTS_GROUP_JID || "";

          // Log group JID if requested
          if (text.toLowerCase().includes("jid") || text.toLowerCase().includes("group id")) {
            try { await sock.sendMessage(jid, { text: "This group JID is:\n" + jid }); } catch (_) {}
            continue;
          }

          // Admin commands from EVENTS GROUP — any member can use !commands
          if (eventsGroup && jid === eventsGroup && text.trim().startsWith("!")) {
            const senderJid = msg.key.participant || jid;
            console.log("[GROUP CMD] " + senderJid + ": " + text.slice(0, 50));
            await admin.handleAdminCommand(text.trim(), eventsGroup).catch(e => console.error("[GroupCmd]", e.message));
            continue;
          }

          // Log all group messages silently
          console.log("[GROUP] " + jid + " | " + pushName + ": " + text.slice(0, 40));
          continue;
        }

        if (!jid) continue;

        // Deduplicate by message ID
        const msgId = msg.key.id;
        if (msgId && _seenMsgIds.has(msgId)) { console.warn("[SKIP] Duplicate: " + msgId); continue; }
        if (msgId) markSeen(msgId);

        console.log("[MSG] JID: " + jid + " | isAdmin: " + admin.isAdminJid(jid) + " | text: " + text.slice(0, 40));

        // Learn admin LID from @lid messages
        if (jid.endsWith("@lid")) admin.learnAdminLid(jid);

        // ── ADMIN DM COMMANDS ──────────────────────────────────────────────────
        const isAdmin = admin.isAdminJid(jid);
        const isLidCmd = jid.endsWith("@lid") && text.trim().startsWith("!");

        if (isAdmin || isLidCmd) {
          if (isLidCmd && !isAdmin) admin.learnAdminLid(jid);
          if (text.trim().startsWith("!")) {
            const handled = await admin.handleAdminCommand(text.trim(), jid).catch(e => { console.error("[AdminCmd]", e.message); return false; });
            if (handled) continue;
            await admin.toDM("Send !help to see all admin commands.");
            continue;
          }
          // Non-command message from admin DM — process normally as customer too
          // (so admin can test the bot from their own number)
        }

        // ── PAYMENT SCREENSHOT / ANY IMAGE ─────────────────────────────────────
        if (hasImage) {
          const phone = jid.replace("@s.whatsapp.net","").replace(/\D/g,"").slice(-10);
          const evGrp = process.env.EVENTS_GROUP_JID || "";
          // Forward the actual image to events group so admin can see it
          if (evGrp && admin._sock) {
            try {
              const imgMsg = msg.message.imageMessage;
              await sock.sendMessage(evGrp, {
                forward: msg,
                force: true,
              });
            } catch (_) {
              // Fallback: just notify with text if forward fails
              await admin.toEventsGroup("📸 PAYMENT SCREENSHOT from " + phone + "\n(Image in customer chat — check WhatsApp)");
            }
          }
          await admin.toDM("📸 PAYMENT SCREENSHOT from " + phone + "\n\nTo confirm payment:\n!send " + phone + " Aapka payment confirm ho gaya ✅ Subscription 2-4 ghante mein activate ho jaayega.");
          await admin.toEventsGroup("📸 SCREENSHOT RECEIVED\n📱 " + phone + "\nCaption: " + (text||"(no caption)") + "\n\nConfirm: !send " + phone + " Payment confirmed ✅");
          // Save screenshot context to profile so AI knows about it
          const { updateProfile } = require('./bot/contextManager');
          await updateProfile(phone, {}).catch(()=>{});
          // Acknowledge to customer
          try { await sock.sendMessage(jid, { text: "Aapka payment screenshot mil gaya ✅ Hamari team verify karke 2-4 ghante mein activate kar degi. Urgent ho to call karein: 6201276506" }); } catch (_) {}
          // Also process any caption text through the bot
          if (text.trim()) {
            handleMessage(sock, jid, text.trim(), pushName).catch(() => {});
          }
          continue;
        }

        // Skip messages with no text
        if (!text.trim()) continue;

        // ── NORMAL CUSTOMER MESSAGE ────────────────────────────────────────────
        handleMessage(sock, jid, text.trim(), pushName).catch(e => console.error("[MsgErr] " + jid + ": " + e.message));
      }
    });

  } catch (err) {
    console.error("[Bot] startBot error:", err.message);
    isConnecting = false;
    setTimeout(startBot, 15_000);
  }
};

startBot();
