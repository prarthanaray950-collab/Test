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

// ── Message deduplication ─────────────────────────────────────────────────────
// Layer 1: exact message-ID dedup — catches WA re-deliveries with same ID
const _seenMsgIds = new Set();
const markSeen = (id) => {
  if (_seenMsgIds.size >= 500) _seenMsgIds.delete(_seenMsgIds.values().next().value);
  _seenMsgIds.add(id);
};

// Layer 2: per-phone time-window dedup — catches rapid duplicate sends (different IDs, same text)
// Window is 8s to match the PROC_DEDUP_MS in contextManager.
const _recentTexts  = new Map();
const DEDUP_WINDOW  = 8000;
const isDuplicateText = (phone, text) => {
  const last = _recentTexts.get(phone);
  if (last && last.text === text && Date.now() - last.ts < DEDUP_WINDOW) return true;
  _recentTexts.set(phone, { text, ts: Date.now() });
  return false;
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
      // Accept both "notify" and "append" — Baileys uses both depending on version
      if (type !== "notify" && type !== "append") return;

      for (const msg of messages) {
        if (msg.key.fromMe) continue;
        const jid = msg.key.remoteJid;
        if (!jid || jid === "status@broadcast") continue;

        // ── REPLAY GUARD ───────────────────────────────────────────────────────
        // On reconnect, Baileys replays recent messages from WA servers.
        // Drop any message older than 30 seconds to ignore replays.
        const msgTs = (msg.messageTimestamp || 0) * 1000; // WA timestamps are in seconds
        if (msgTs && Date.now() - msgTs > 30000) {
          console.warn("[SKIP] Old message (replay?): " + new Date(msgTs).toISOString() + " | " + jid);
          continue;
        }

        // Extract text from ALL possible message wrapper types
        // (Baileys wraps messages differently based on WA version and ephemeral settings)
        const inner = msg.message || {};
        const text =
          inner.conversation ||
          inner.extendedTextMessage?.text ||
          inner.imageMessage?.caption ||
          inner.videoMessage?.caption ||
          inner.buttonsResponseMessage?.selectedButtonId ||
          inner.listResponseMessage?.singleSelectReply?.selectedRowId ||
          // Ephemeral/view-once wrappers — these are the most commonly missed
          inner.ephemeralMessage?.message?.conversation ||
          inner.ephemeralMessage?.message?.extendedTextMessage?.text ||
          inner.viewOnceMessage?.message?.conversation ||
          inner.viewOnceMessage?.message?.extendedTextMessage?.text ||
          inner.documentWithCaptionMessage?.message?.imageMessage?.caption ||
          inner.editedMessage?.message?.protocolMessage?.editedMessage?.conversation ||
          "";

        const hasImage = !!(inner.imageMessage ||
          inner.ephemeralMessage?.message?.imageMessage ||
          inner.viewOnceMessage?.message?.imageMessage);

        // ptt = push-to-talk = voice note recorded in WhatsApp
        // We check ptt:true OR seconds>0 to cover all Baileys versions
        const audioMsg = inner.audioMessage || inner.ephemeralMessage?.message?.audioMessage;
        const hasAudio = !!(audioMsg && (audioMsg.ptt === true || (audioMsg.seconds || 0) > 0));

        const pushName = msg.pushName || "";

        // ── GROUP MESSAGES ─────────────────────────────────────────────────────
        if (isJidGroup(jid)) {
          const eventsGroup = process.env.EVENTS_GROUP_JID || "";
          if (text.toLowerCase().includes("jid") || text.toLowerCase().includes("group id")) {
            try { await sock.sendMessage(jid, { text: "This group JID is:\n" + jid }); } catch (_) {}
            continue;
          }
          if (eventsGroup && jid === eventsGroup && text.trim().startsWith("!")) {
            console.log("[GROUP CMD] " + (msg.key.participant || jid) + ": " + text.slice(0, 50));
            await admin.handleAdminCommand(text.trim(), eventsGroup).catch(e => console.error("[GroupCmd]", e.message));
            continue;
          }
          console.log("[GROUP] " + jid + " | " + pushName + ": " + text.slice(0, 40));
          continue;
        }

        // ── DEDUP: Layer 1 — message ID ────────────────────────────────────────
        const msgId = msg.key.id;
        if (msgId && _seenMsgIds.has(msgId)) {
          console.warn("[SKIP] Duplicate ID: " + msgId);
          continue;
        }
        if (msgId) markSeen(msgId);

        // ── DEDUP: Layer 2 — same text within 8s window ────────────────────────
        const phone = jid.replace("@s.whatsapp.net","").replace(/\D/g,"").slice(-10);
        if (text.trim() && isDuplicateText(phone, text.trim())) {
          console.warn("[SKIP] Duplicate text within window: " + phone + " — " + text.slice(0,30));
          continue;
        }

        console.log("[MSG] " + phone + " | type=" + type + " | text=\"" + text.slice(0,40) + "\" | hasImage=" + hasImage + " | hasAudio=" + hasAudio + " | msgKeys=" + Object.keys(inner).join(",").slice(0,80));

        if (jid.endsWith("@lid")) admin.learnAdminLid(jid);

        // ── ADMIN DM COMMANDS ──────────────────────────────────────────────────
        const isAdmin  = admin.isAdminJid(jid);
        const isLidCmd = jid.endsWith("@lid") && text.trim().startsWith("!");
        if (isAdmin || isLidCmd) {
          if (isLidCmd && !isAdmin) admin.learnAdminLid(jid);
          if (text.trim().startsWith("!")) {
            const handled = await admin.handleAdminCommand(text.trim(), jid).catch(e => { console.error("[AdminCmd]", e.message); return false; });
            if (handled) continue;
            await admin.toDM("Send !help to see all admin commands.");
            continue;
          }
        }

        // ── PAYMENT SCREENSHOT ─────────────────────────────────────────────────
        if (hasImage) {
          if (msgId && msgId.startsWith("BAE5")) {
            console.warn("[SKIP] Own message re-delivered as image: " + msgId);
            continue;
          }
          const evGrp = process.env.EVENTS_GROUP_JID || "";
          if (evGrp && admin._sock) {
            try { await sock.sendMessage(evGrp, { forward: msg, force: true }); }
            catch (_) { await admin.toEventsGroup("📸 PAYMENT SCREENSHOT from " + phone + "\n(Check customer chat)"); }
          }
          await admin.toDM("📸 PAYMENT SCREENSHOT from " + phone + "\n\nTo confirm:\n!send " + phone + " Aapka payment confirm ho gaya ✅ Subscription 2-4 ghante mein activate ho jaayega.");
          await admin.toEventsGroup("📸 SCREENSHOT RECEIVED\n📱 " + phone + "\nCaption: " + (text||"(none)") + "\n\nConfirm: !send " + phone + " Payment confirmed ✅");
          try { await sock.sendMessage(jid, { text: "Aapka payment screenshot mil gaya ✅ Hamari team verify karke 2-4 ghante mein activate kar degi. Urgent ho to call karein: 6201276506" }); } catch (_) {}
          if (text.trim()) handleMessage(sock, jid, text.trim(), pushName).catch(() => {});
          continue;
        }

        // ── LOCATION SHARING ───────────────────────────────────────────────────
        const locMsg = inner.locationMessage;
        if (locMsg) {
          const lat = locMsg.degreesLatitude, lng = locMsg.degreesLongitude;
          const mapsUrl = "https://www.google.com/maps?q=" + lat + "," + lng;
          const ctxMod = require('./bot/contextManager');
          const { profile: locProfile } = await ctxMod.getHistoryAndProfile(phone).catch(() => ({ profile: {} }));
          await admin.toEventsGroup("📍 LOCATION\n\n👤 " + (locProfile?.name||"Unknown") + "\n📱 " + phone + "\n🗺 " + mapsUrl + "\n\n!send " + phone + " Aapke area mein delivery available hai ✅");
          try { await sock.sendMessage(jid, { text: "Aapki location mil gayi 🌿 Hamari team 1-2 ghante mein confirm karegi. Ya call karein: 6201276506" }); } catch (_) {}
          continue;
        }

        // ── VOICE NOTE ─────────────────────────────────────────────────────────
        if (hasAudio) {
          const voiceProcessor = require('./bot/voiceProcessor');
          if (voiceProcessor.isAvailable()) {
            try { await sock.sendPresenceUpdate("composing", jid); } catch (_) {}
            const transcribed = await voiceProcessor.transcribe(msg, sock).catch(() => null);
            if (transcribed) {
              console.log("[VOICE] Transcribed: " + transcribed.slice(0,60));
              try { await sock.sendMessage(jid, { text: "Aapne bola: \"" + transcribed + "\"\n\nProcess kar raha hoon 🌿" }); } catch (_) {}
              handleMessage(sock, jid, transcribed, pushName).catch(() => {});
            } else {
              try { await sock.sendMessage(jid, { text: "Voice clearly nahi sun paya 🙏 Apna order ya sawaal text mein likh kar bhejein — jaldi reply milegi!" }); } catch (_) {}
            }
          } else {
            // Voice transcription not set up — ask them to type
            try { await sock.sendMessage(jid, { text: "Voice note mila ✅ Lekin abhi voice samajhna mushkil hai 🙏\n\nApna order ya sawaal text mein likh kar bhejein — bahut jaldi reply milegi!\n\nExample: \"1 plate lunch aaj chahiye\" ya \"monthly plan lena hai\" 🌿" }); } catch (_) {}
          }
          continue;
        }

        // Skip empty text (stickers, reactions, etc.)
        if (!text.trim()) {
          console.log("[SKIP] Empty text after extraction — msgKeys: " + Object.keys(inner).join(",").slice(0,80));
          continue;
        }

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
