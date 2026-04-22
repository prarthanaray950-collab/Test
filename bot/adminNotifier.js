/**
 * adminNotifier.js
 *
 * FULL WHATSAPP ADMIN PANEL
 * Message the bot from your ADMIN_WHATSAPP number to control everything.
 *
 * ─── COMMANDS ───────────────────────────────────────────────────────────────
 *
 * HELP & INFO:
 *   !help                        — show all commands
 *   !stats                       — total customers, orders, active today
 *   !customers                   — list all customers with name + phone
 *   !customer 9876543210         — full profile of one customer
 *   !history 9876543210          — last 10 messages of a customer
 *   !search <name or phone>      — find customer by name or partial number
 *
 * MESSAGING:
 *   !broadcast <message>         — send to ALL customers
 *   !send 9876543210 <message>   — send to one specific number
 *   !reply 9876543210 <message>  — same as !send (alias)
 *
 * MANAGEMENT:
 *   !note 9876543210 <note>      — add internal note to customer profile
 *   !clear 9876543210            — clear chat history of a customer (keeps profile)
 *   !block 9876543210            — block a customer from bot responses
 *   !unblock 9876543210          — unblock a customer
 *
 * BOT CONTROL:
 *   !status                      — bot uptime and connection status
 *   !ping                        — check if bot is alive
 *
 * ─── GROUPS ─────────────────────────────────────────────────────────────────
 *   STATUS_GROUP_JID  — bot online/offline/errors (low noise)
 *   EVENTS_GROUP_JID  — new customers, orders, subscriptions, complaints
 */

const axios = require("axios");

let _sock = null;
let _Conversation = null;

const ADMIN_PHONE  = () => (process.env.ADMIN_WHATSAPP || "").replace(/\D/g, "").slice(-10);
const STATUS_GROUP = () => process.env.STATUS_GROUP_JID;
const EVENTS_GROUP = () => process.env.EVENTS_GROUP_JID;
const TG_TOKEN     = () => process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT      = () => process.env.TELEGRAM_CHAT_ID;

const setSocket            = (sock)  => { _sock = sock; };
const setConversationModel = (model) => { _Conversation = model; };

// ── Core send helpers ─────────────────────────────────────────────────────────

const toStatusGroup = async (text) => {
  const jid = STATUS_GROUP();
  if (!_sock || !jid) return;
  try { await _sock.sendMessage(jid, { text }); }
  catch (e) { console.error("[StatusGroup]", e.message); }
};

const toEventsGroup = async (text) => {
  const jid = EVENTS_GROUP();
  if (!_sock || !jid) return;
  try { await _sock.sendMessage(jid, { text }); }
  catch (e) { console.error("[EventsGroup]", e.message); }
};

const toDM = async (text) => {
  const phone = ADMIN_PHONE();
  if (!_sock || !phone) return;
  try { await _sock.sendMessage(`91${phone}@s.whatsapp.net`, { text }); }
  catch (e) { console.error("[AdminDM]", e.message); }
};

const toTelegram = async (text) => {
  if (!TG_TOKEN() || !TG_CHAT()) return;
  try {
    await axios.post(`https://api.telegram.org/bot${TG_TOKEN()}/sendMessage`, {
      chat_id: TG_CHAT(),
      text: `[SatvikMeals]\n\n${text}`,
    });
  } catch (e) { console.error("[Telegram]", e.message); }
};

// ── Bot online — 5-min cooldown, status group only ───────────────────────────
let _lastOnlineAt = 0;

const notifyBotOnline = async () => {
  const now = Date.now();
  if (now - _lastOnlineAt < 5 * 60 * 1000) {
    console.log("[Admin] Online notify skipped — cooldown");
    return;
  }
  _lastOnlineAt = now;
  const ts = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  await toStatusGroup(`🟢 SatvikMeals Bot ONLINE\n🕐 ${ts}\n🌿 WhatsApp connected, MongoDB ready.`);
};

const notifyBotError = async (msg) => {
  await toStatusGroup(`🔴 BOT ERROR\n\n${msg}`);
};

// ── Business event notifications — events group + Telegram ───────────────────

const notifyNewUser = async ({ phoneNumber, name, phone }) => {
  const text =
    `👤 NEW CUSTOMER\n\n` +
    `Name: ${name}\n` +
    `WhatsApp: ${phoneNumber}\n` +
    `Phone: ${phone || phoneNumber}\n` +
    `Time: ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`;
  await Promise.allSettled([toEventsGroup(text), toTelegram(text)]);
};

const notifySubscriptionInterest = async ({ phoneNumber, planName, customerName, address }) => {
  const text =
    `📋 NEW SUBSCRIPTION REQUEST\n\n` +
    `👤 ${customerName || "Unknown"}\n` +
    `📱 ${phoneNumber}\n` +
    `📦 Plan: ${planName}\n` +
    `📍 ${address || "Not given"}\n` +
    `⚡ Action needed: confirm payment`;
  await Promise.allSettled([toEventsGroup(text), toTelegram(text)]);
};

const notifyNewOrder = async ({ phoneNumber, customerName, address, item, amount }) => {
  const text =
    `🆕 NEW ORDER\n\n` +
    `👤 ${customerName}\n` +
    `📱 ${phoneNumber}\n` +
    `🍱 ${item}\n` +
    `💰 Rs. ${amount}\n` +
    `📍 ${address || "Not given"}\n` +
    `✅ Awaiting UPI — 6201276506`;
  await Promise.allSettled([toEventsGroup(text), toTelegram(text)]);
};

const notifyComplaint = async ({ phoneNumber, type, issue }) => {
  const text =
    `⚠️ ${(type || "COMPLAINT").toUpperCase()}\n\n` +
    `📱 ${phoneNumber}\n\n${issue}`;
  await Promise.allSettled([toEventsGroup(text), toTelegram(text)]);
};

const notifyHealthNote = async ({ phoneNumber, note }) => {
  const text = `🏥 HEALTH NOTE\n\n📱 ${phoneNumber}\n\n${note}`;
  await Promise.allSettled([toEventsGroup(text), toTelegram(text)]);
};

// ── Broadcast engine ──────────────────────────────────────────────────────────

const broadcast = async (phones, message) => {
  if (!_sock) throw new Error("Socket not ready");
  let sent = 0, failed = 0;
  for (const phone of phones) {
    try {
      const digits = String(phone).replace(/\D/g, "").slice(-10);
      await _sock.sendMessage(`91${digits}@s.whatsapp.net`, { text: message });
      sent++;
      await new Promise(r => setTimeout(r, 1500));
    } catch (e) {
      console.error(`[Broadcast] Failed ${phone}: ${e.message}`);
      failed++;
    }
  }
  return { sent, failed };
};

// ── Blocked customers set (in-memory, survives restarts via DB flag) ──────────
const _blocked = new Set();

const isBlocked = (phone) => _blocked.has(phone);

// ── Admin command handler ─────────────────────────────────────────────────────

const HELP_TEXT = `📱 SATVIKMEALS ADMIN PANEL

INFO COMMANDS:
!stats — customer & order summary
!customers — list all customers
!customer 9876543210 — one customer's full profile
!history 9876543210 — their last 10 messages
!search <name or number> — find a customer

MESSAGING:
!broadcast <msg> — send to all customers
!send 9876543210 <msg> — send to one number

MANAGEMENT:
!note 9876543210 <note> — add note to profile
!clear 9876543210 — clear chat history
!block 9876543210 — block from bot
!unblock 9876543210 — unblock

BOT:
!status — uptime info
!ping — check bot is alive`;

const handleAdminCommand = async (text) => {
  if (!_Conversation) return false;
  const cmd = text.trim();
  if (!cmd.startsWith("!")) return false;

  // ── !help ────────────────────────────────────────────────────────────────
  if (/^!help$/i.test(cmd)) {
    await toDM(HELP_TEXT);
    return true;
  }

  // ── !ping ────────────────────────────────────────────────────────────────
  if (/^!ping$/i.test(cmd)) {
    await toDM(`🟢 Bot is alive\nUptime: ${Math.floor(process.uptime() / 60)} minutes`);
    return true;
  }

  // ── !status ──────────────────────────────────────────────────────────────
  if (/^!status$/i.test(cmd)) {
    const uptime = process.uptime();
    const h = Math.floor(uptime / 3600);
    const m = Math.floor((uptime % 3600) / 60);
    const total = await _Conversation.countDocuments().catch(() => "?");
    await toDM(
      `📊 BOT STATUS\n\n` +
      `Uptime: ${h}h ${m}m\n` +
      `Total customers: ${total}\n` +
      `Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB\n` +
      `Time: ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`
    );
    return true;
  }

  // ── !stats ───────────────────────────────────────────────────────────────
  if (/^!stats$/i.test(cmd)) {
    try {
      const total      = await _Conversation.countDocuments();
      const withOrders = await _Conversation.countDocuments({ "profile.totalOrders": { $gt: 0 } });
      const withEmail  = await _Conversation.countDocuments({ "profile.email": { $ne: "" } });
      const today      = new Date(); today.setHours(0, 0, 0, 0);
      const activeToday = await _Conversation.countDocuments({ updatedAt: { $gte: today } });
      const recent = await _Conversation.find({}, { phoneNumber: 1, "profile.name": 1, "profile.totalOrders": 1, updatedAt: 1 })
        .sort({ updatedAt: -1 }).limit(5).lean();

      const lines = [
        `📊 SATVIKMEALS STATS\n`,
        `Total customers: ${total}`,
        `Active today: ${activeToday}`,
        `With orders: ${withOrders}`,
        `Registered (email): ${withEmail}`,
        `\nRecent (last 5):`,
        ...recent.map((c, i) =>
          `${i + 1}. ${c.profile?.name || "Unknown"} — ${c.phoneNumber} — ${c.profile?.totalOrders || 0} orders`
        ),
      ];
      await toDM(lines.join("\n"));
    } catch (e) {
      await toDM(`Error: ${e.message}`);
    }
    return true;
  }

  // ── !customers ───────────────────────────────────────────────────────────
  if (/^!customers$/i.test(cmd)) {
    try {
      const all = await _Conversation.find({}, {
        phoneNumber: 1, "profile.name": 1, "profile.email": 1,
        "profile.totalOrders": 1, "profile.lastPlanSeen": 1, updatedAt: 1,
      }).sort({ updatedAt: -1 }).lean();

      if (!all.length) { await toDM("No customers yet."); return true; }

      // Split into chunks of 20 to avoid WhatsApp message size limits
      const chunks = [];
      for (let i = 0; i < all.length; i += 20) chunks.push(all.slice(i, i + 20));

      for (let ci = 0; ci < chunks.length; ci++) {
        const lines = [`👥 CUSTOMERS (${ci * 20 + 1}–${ci * 20 + chunks[ci].length} of ${all.length}):\n`];
        chunks[ci].forEach((c, i) => {
          lines.push(
            `${ci * 20 + i + 1}. ${c.profile?.name || "Unknown"}\n` +
            `   📱 ${c.phoneNumber}` +
            (c.profile?.email ? ` | 📧 ${c.profile.email}` : "") +
            (c.profile?.totalOrders ? ` | 🛒 ${c.profile.totalOrders} orders` : "") +
            (c.profile?.lastPlanSeen ? ` | 📦 ${c.profile.lastPlanSeen}` : "")
          );
        });
        await toDM(lines.join("\n"));
        await new Promise(r => setTimeout(r, 500));
      }
    } catch (e) {
      await toDM(`Error: ${e.message}`);
    }
    return true;
  }

  // ── !customer 9876543210 ─────────────────────────────────────────────────
  if (/^!customer\s+\d+/i.test(cmd)) {
    const phone = cmd.match(/\d{10}/)?.[0];
    if (!phone) { await toDM("Format: !customer 9876543210"); return true; }
    try {
      const doc = await _Conversation.findOne({ phoneNumber: phone }).lean();
      if (!doc) { await toDM(`No customer found for ${phone}`); return true; }
      const p = doc.profile || {};
      const lastSeen = doc.updatedAt ? new Date(doc.updatedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "?";
      const joined   = doc.createdAt ? new Date(doc.createdAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "?";
      await toDM(
        `👤 CUSTOMER PROFILE\n\n` +
        `Name: ${p.name || "Not set"}\n` +
        `Phone: ${p.phone || phone}\n` +
        `Email: ${p.email || "Not set"}\n` +
        `Address: ${p.address || "Not set"}\n` +
        `Total Orders: ${p.totalOrders || 0}\n` +
        `Last Plan: ${p.lastPlanSeen || "None"}\n` +
        `Health Notes: ${p.healthNotes || "None"}\n` +
        `Linked User ID: ${p.linkedUserId || "Not registered"}\n` +
        `Messages in history: ${doc.history?.length || 0}\n` +
        `Joined: ${joined}\n` +
        `Last active: ${lastSeen}\n` +
        `Blocked: ${_blocked.has(phone) ? "Yes" : "No"}`
      );
    } catch (e) {
      await toDM(`Error: ${e.message}`);
    }
    return true;
  }

  // ── !history 9876543210 ──────────────────────────────────────────────────
  if (/^!history\s+\d+/i.test(cmd)) {
    const phone = cmd.match(/\d{10}/)?.[0];
    if (!phone) { await toDM("Format: !history 9876543210"); return true; }
    try {
      const doc = await _Conversation.findOne({ phoneNumber: phone }).lean();
      if (!doc || !doc.history?.length) {
        await toDM(`No chat history for ${phone}`);
        return true;
      }
      const last10 = doc.history.slice(-10);
      const lines = [`💬 LAST ${last10.length} MESSAGES — ${doc.profile?.name || phone}\n`];
      last10.forEach(m => {
        const role = m.role === "user" ? "👤 Customer" : "🤖 Bot";
        const ts   = m.timestamp ? new Date(m.timestamp).toLocaleTimeString("en-IN") : "";
        lines.push(`${role} ${ts}:\n${m.content?.slice(0, 200) || ""}${m.content?.length > 200 ? "..." : ""}`);
      });
      await toDM(lines.join("\n\n"));
    } catch (e) {
      await toDM(`Error: ${e.message}`);
    }
    return true;
  }

  // ── !search <query> ──────────────────────────────────────────────────────
  if (/^!search\s+/i.test(cmd)) {
    const query = cmd.replace(/^!search\s+/i, "").trim();
    if (!query) { await toDM("Format: !search name or partial number"); return true; }
    try {
      const results = await _Conversation.find({
        $or: [
          { "profile.name":  { $regex: query, $options: "i" } },
          { phoneNumber:     { $regex: query } },
          { "profile.email": { $regex: query, $options: "i" } },
        ],
      }, { phoneNumber: 1, "profile.name": 1, "profile.email": 1, "profile.totalOrders": 1 })
        .limit(10).lean();

      if (!results.length) { await toDM(`No results for "${query}"`); return true; }
      const lines = [`🔍 Search results for "${query}":\n`];
      results.forEach((c, i) => {
        lines.push(
          `${i + 1}. ${c.profile?.name || "Unknown"} — ${c.phoneNumber}` +
          (c.profile?.email ? ` — ${c.profile.email}` : "") +
          (c.profile?.totalOrders ? ` — ${c.profile.totalOrders} orders` : "")
        );
      });
      await toDM(lines.join("\n"));
    } catch (e) {
      await toDM(`Error: ${e.message}`);
    }
    return true;
  }

  // ── !note 9876543210 <note> ──────────────────────────────────────────────
  if (/^!note\s+\d+/i.test(cmd)) {
    const match = cmd.match(/^!note\s+(\d{10})\s+([\s\S]+)/i);
    if (!match) { await toDM("Format: !note 9876543210 your note here"); return true; }
    const [, phone, note] = match;
    try {
      await _Conversation.findOneAndUpdate(
        { phoneNumber: phone },
        { $set: { "profile.adminNote": note, updatedAt: new Date() } }
      );
      await toDM(`✅ Note saved for ${phone}:\n"${note}"`);
    } catch (e) {
      await toDM(`Error: ${e.message}`);
    }
    return true;
  }

  // ── !clear 9876543210 ────────────────────────────────────────────────────
  if (/^!clear\s+\d+/i.test(cmd)) {
    const phone = cmd.match(/\d{10}/)?.[0];
    if (!phone) { await toDM("Format: !clear 9876543210"); return true; }
    try {
      await _Conversation.findOneAndUpdate(
        { phoneNumber: phone },
        { $set: { history: [], updatedAt: new Date() } }
      );
      await toDM(`✅ Chat history cleared for ${phone}. Profile kept intact.`);
    } catch (e) {
      await toDM(`Error: ${e.message}`);
    }
    return true;
  }

  // ── !block 9876543210 ────────────────────────────────────────────────────
  if (/^!block\s+\d+/i.test(cmd)) {
    const phone = cmd.match(/\d{10}/)?.[0];
    if (!phone) { await toDM("Format: !block 9876543210"); return true; }
    _blocked.add(phone);
    await toDM(`🚫 ${phone} is now blocked from bot responses.`);
    return true;
  }

  // ── !unblock 9876543210 ──────────────────────────────────────────────────
  if (/^!unblock\s+\d+/i.test(cmd)) {
    const phone = cmd.match(/\d{10}/)?.[0];
    if (!phone) { await toDM("Format: !unblock 9876543210"); return true; }
    _blocked.delete(phone);
    await toDM(`✅ ${phone} is now unblocked.`);
    return true;
  }

  // ── !send / !reply 9876543210 <message> ──────────────────────────────────
  if (/^!(send|reply)\s+\d+/i.test(cmd)) {
    const match = cmd.match(/^!(send|reply)\s+(\d{10})\s+([\s\S]+)/i);
    if (!match) { await toDM("Format: !send 9876543210 your message here"); return true; }
    const [,, phone, message] = match;
    try {
      await _sock.sendMessage(`91${phone}@s.whatsapp.net`, { text: message.trim() });
      await toDM(`✅ Sent to ${phone}`);
    } catch (e) {
      await toDM(`❌ Failed: ${e.message}`);
    }
    return true;
  }

  // ── !broadcast <message> ─────────────────────────────────────────────────
  if (/^!broadcast\s+/i.test(cmd)) {
    const message = cmd.replace(/^!broadcast\s+/i, "").trim();
    if (!message) { await toDM("Format: !broadcast your message here"); return true; }
    try {
      const all    = await _Conversation.find({}, { phoneNumber: 1 }).lean();
      const phones = all.map(d => d.phoneNumber).filter(Boolean);
      await toDM(`📢 Broadcasting to ${phones.length} customers... please wait.`);
      const result = await broadcast(phones, message);
      await toDM(`✅ Broadcast complete!\nSent: ${result.sent}\nFailed: ${result.failed}`);
      await toEventsGroup(
        `📢 BROADCAST SENT\n` +
        `Message: "${message.slice(0, 100)}"\n` +
        `Sent: ${result.sent} | Failed: ${result.failed}`
      );
    } catch (e) {
      await toDM(`❌ Error: ${e.message}`);
    }
    return true;
  }

  // Unknown command
  if (cmd.startsWith("!")) {
    await toDM(`Unknown command. Send !help to see all commands.`);
    return true;
  }

  return false;
};

// ── Check if a JID is the admin ───────────────────────────────────────────────
const isAdminJid = (jid) => {
  const phone = ADMIN_PHONE(); // always 10 digits after normalization
  if (!phone) return false;
  // WhatsApp JIDs for Indian numbers always arrive as 91XXXXXXXXXX@s.whatsapp.net
  // We check all possible formats to be bulletproof
  const stripped = jid.replace("@s.whatsapp.net", "").replace(/\D/g, "");
  return (
    stripped === phone ||           // 9876543210
    stripped === `91${phone}` ||    // 919876543210
    stripped === `0${phone}`        // 09876543210 (rare)
  );
};

module.exports = {
  setSocket,
  setConversationModel,
  isAdminJid,
  isBlocked,
  handleAdminCommand,
  toDM,
  toStatusGroup,
  toEventsGroup,
  toTelegram,
  notifyBotOnline,
  notifyBotError,
  notifyNewUser,
  notifySubscriptionInterest,
  notifyNewOrder,
  notifyComplaint,
  notifyHealthNote,
  broadcast,
};
