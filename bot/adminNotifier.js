/**
 * adminNotifier.js
 *
 * TWO GROUPS:
 *   STATUS_GROUP_JID  = bot online/offline, reconnects, errors — low noise
 *   EVENTS_GROUP_JID  = new customers, orders, subscriptions, complaints — action items
 *
 * BROADCAST FROM WHATSAPP:
 *   Admin sends a message to the bot (DM) starting with "!broadcast"
 *   Example: "!broadcast Aaj ka special offer: ..."
 *   Bot broadcasts to all customers automatically.
 *   Other admin commands:
 *     !stats           — shows customer count, order count
 *     !broadcast <msg> — broadcast to all customers
 *     !send 9876543210 <msg> — send to specific number
 *
 * ENV VARS NEEDED:
 *   ADMIN_WHATSAPP   = your 10-digit number (for admin DM commands)
 *   STATUS_GROUP_JID = 120363...@g.us  (bot status group)
 *   EVENTS_GROUP_JID = 120363...@g.us  (business events group)
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (optional)
 */

const axios = require("axios");

let _sock = null;
let _Conversation = null; // injected after DB connect

const ADMIN_PHONE      = () => (process.env.ADMIN_WHATSAPP || "").replace(/\D/g, "").slice(-10);
const STATUS_GROUP     = () => process.env.STATUS_GROUP_JID;   // bot online/offline logs
const EVENTS_GROUP     = () => process.env.EVENTS_GROUP_JID;   // orders, customers, plans
const TG_TOKEN         = () => process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT          = () => process.env.TELEGRAM_CHAT_ID;

const setSocket = (sock) => { _sock = sock; };
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

// ── Bot online — 5-min cooldown, goes to STATUS group only ───────────────────
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

// ── Business event notifications — all go to EVENTS group + Telegram ─────────

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
    `📍 ${address || "Address not given"}\n` +
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
    `✅ Awaiting UPI payment — 6201276506`;
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
      await new Promise(r => setTimeout(r, 1500)); // rate limit gap
    } catch (e) {
      console.error(`[Broadcast] Failed ${phone}: ${e.message}`);
      failed++;
    }
  }
  return { sent, failed };
};

// ── Admin WhatsApp command handler ────────────────────────────────────────────
// Called from index.js when a message arrives from the admin's own number.
// Commands:
//   !broadcast <message>           — send to all customers
//   !send 9876543210 <message>     — send to one number
//   !stats                         — show customer + order stats

const handleAdminCommand = async (text) => {
  const cmd = text.trim();

  // !stats
  if (/^!stats/i.test(cmd)) {
    try {
      const total = await _Conversation.countDocuments();
      const withOrders = await _Conversation.countDocuments({ "profile.totalOrders": { $gt: 0 } });
      const recent = await _Conversation.find({}, { phoneNumber: 1, "profile.name": 1, "profile.totalOrders": 1 })
        .sort({ updatedAt: -1 }).limit(5).lean();
      const lines = [
        `📊 SATVIKMEALS BOT STATS\n`,
        `Total customers: ${total}`,
        `Customers with orders: ${withOrders}`,
        `\nRecent active customers:`,
        ...recent.map((c, i) => `${i + 1}. ${c.profile?.name || "Unknown"} — ${c.phoneNumber} (${c.profile?.totalOrders || 0} orders)`),
      ];
      await toDM(lines.join("\n"));
    } catch (e) {
      await toDM(`Stats error: ${e.message}`);
    }
    return true;
  }

  // !send 9876543210 message
  if (/^!send\s+\d{10}/i.test(cmd)) {
    const match = cmd.match(/^!send\s+(\d{10})\s+([\s\S]+)/i);
    if (!match) { await toDM("Format: !send 9876543210 your message here"); return true; }
    const [, phone, message] = match;
    try {
      await _sock.sendMessage(`91${phone}@s.whatsapp.net`, { text: message.trim() });
      await toDM(`✅ Sent to ${phone}`);
    } catch (e) {
      await toDM(`❌ Failed: ${e.message}`);
    }
    return true;
  }

  // !broadcast message
  if (/^!broadcast\s+/i.test(cmd)) {
    const message = cmd.replace(/^!broadcast\s+/i, "").trim();
    if (!message) { await toDM("Format: !broadcast your message here"); return true; }
    try {
      const all = await _Conversation.find({}, { phoneNumber: 1 }).lean();
      const phones = all.map(d => d.phoneNumber).filter(Boolean);
      await toDM(`📢 Broadcasting to ${phones.length} customers... please wait.`);
      const result = await broadcast(phones, message);
      await toDM(`✅ Broadcast done!\nSent: ${result.sent}\nFailed: ${result.failed}`);
      await toEventsGroup(`📢 BROADCAST SENT\n\nMessage: "${message.slice(0, 100)}"\nSent: ${result.sent} | Failed: ${result.failed}`);
    } catch (e) {
      await toDM(`❌ Broadcast error: ${e.message}`);
    }
    return true;
  }

  return false; // not an admin command
};

// Check if a JID belongs to the admin
const isAdminJid = (jid) => {
  const phone = ADMIN_PHONE();
  if (!phone) return false;
  return jid === `${phone}@s.whatsapp.net` ||
         jid === `91${phone}@s.whatsapp.net`;
};

module.exports = {
  setSocket,
  setConversationModel,
  isAdminJid,
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
