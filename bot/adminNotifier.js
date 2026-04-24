/**
 * adminNotifier.js
 *
 * TWO GROUPS:
 *   STATUS_GROUP_JID  = bot online/offline (low noise)
 *   EVENTS_GROUP_JID  = all business events AND admin command panel
 *
 * ADMIN COMMANDS work from:
 *   1. Your personal DM to the bot
 *   2. Any message in EVENTS_GROUP starting with !
 *   3. Any @lid JID that sends a ! command (auto-learns as admin)
 *
 * COMMANDS:
 *   !help                        — show all commands
 *   !stats                       — customer & order summary
 *   !customers                   — list all customers
 *   !customer 9876543210         — full profile
 *   !history 9876543210          — last 10 messages
 *   !search <name/number>        — find customer
 *   !broadcast <msg>             — send text to ALL customers
 *   !broadcastimg <url> <caption>— send image to all customers
 *   !send 9876543210 <msg>       — send text to one number
 *   !sendimg 9876543210 <url>    — send image to one number
 *   !note 9876543210 <note>      — add admin note
 *   !clear 9876543210            — clear chat history
 *   !block 9876543210            — block customer
 *   !unblock 9876543210          — unblock customer
 *   !unfreeze 9876543210         — return to bot after owner transfer
 *   !remind                      — run subscription reminders now
 *   !feedback                    — run feedback collection now
 *   !offer <msg>                 — send promotional offer to all
 *   !status                      — bot uptime
 *   !ping                        — alive check
 */

const axios = require("axios");

let _sock             = null;
let _Conversation     = null;
let _adminLid         = null;   // learned at runtime, lost on restart (use ADMIN_LID env to persist)

const ADMIN_PHONE  = () => (process.env.ADMIN_WHATSAPP || "").replace(/\D/g, "").slice(-10);
const STATUS_GROUP = () => process.env.STATUS_GROUP_JID  || "";
const EVENTS_GROUP = () => process.env.EVENTS_GROUP_JID  || "";
const TG_TOKEN     = () => process.env.TELEGRAM_BOT_TOKEN || "";
const TG_CHAT      = () => process.env.TELEGRAM_CHAT_ID   || "";

const setSocket            = (sock)  => { _sock = sock; };
const setConversationModel = (model) => { _Conversation = model; };

// ── Core send helpers ──────────────────────────────────────────────────────────
const toStatusGroup = async (text) => {
  if (!_sock || !STATUS_GROUP()) return;
  try { await _sock.sendMessage(STATUS_GROUP(), { text }); } catch (e) { console.error("[StatusGroup]", e.message); }
};

const toEventsGroup = async (text) => {
  if (!_sock || !EVENTS_GROUP()) return;
  try { await _sock.sendMessage(EVENTS_GROUP(), { text }); } catch (e) { console.error("[EventsGroup]", e.message); }
};

const toEventsGroupImage = async (url, caption) => {
  if (!_sock || !EVENTS_GROUP()) return;
  try { await _sock.sendMessage(EVENTS_GROUP(), { image: { url }, caption: caption || "" }); } catch (e) { console.error("[EventsGroupImg]", e.message); }
};

// Reply to wherever the admin command came from (group or DM)
let _lastCommandSource = null; // jid of last command sender
const replyToAdmin = async (text) => {
  if (!_sock) return;
  const targets = new Set();
  const phone = ADMIN_PHONE();
  if (phone) targets.add("91" + phone + "@s.whatsapp.net");
  if (_lastCommandSource) targets.add(_lastCommandSource);
  for (const jid of targets) {
    try { await _sock.sendMessage(jid, { text }); } catch (e) { console.error("[AdminReply]", e.message); }
  }
};

const toDM = async (text) => {
  const phone = ADMIN_PHONE();
  if (!_sock || !phone) return;
  try { await _sock.sendMessage("91" + phone + "@s.whatsapp.net", { text }); } catch (e) { console.error("[AdminDM]", e.message); }
};

const toTelegram = async (text) => {
  if (!TG_TOKEN() || !TG_CHAT()) return;
  try {
    await axios.post("https://api.telegram.org/bot" + TG_TOKEN() + "/sendMessage", {
      chat_id: TG_CHAT(),
      text: "[SatvikMeals]\n\n" + text,
    });
  } catch (e) { console.error("[Telegram]", e.message); }
};

// ── Is this JID an admin? ──────────────────────────────────────────────────────
// Admin = personal DM from ADMIN_WHATSAPP phone number
//       OR any message from EVENTS_GROUP (all members can use commands)
//       OR a learned/configured @lid
const isAdminJid = (jid) => {
  // Events group members = admins
  if (EVENTS_GROUP() && jid === EVENTS_GROUP()) return true;

  const phone = ADMIN_PHONE();
  if (jid.endsWith("@s.whatsapp.net") && phone) {
    const stripped = jid.replace("@s.whatsapp.net", "").replace(/\D/g, "");
    if (stripped === phone || stripped === "91" + phone) return true;
  }

  if (jid.endsWith("@lid")) {
    const envLid = (process.env.ADMIN_LID || "").trim();
    if (envLid && jid === envLid) return true;
    if (_adminLid && jid === _adminLid) return true;
  }

  return false;
};

// Learn admin LID on first ! command from @lid
const learnAdminLid = (jid) => {
  if (!jid.endsWith("@lid")) return;
  if (_adminLid === jid) return;
  _adminLid = jid;
  console.log("[Admin] LID learned: " + jid + " — add ADMIN_LID=" + jid + " to Render env to persist");
  const envLid = (process.env.ADMIN_LID || "").trim();
  if (!envLid) {
    toDM("Admin LID detected: " + jid + "\n\nAdd to Render env to persist across restarts:\nADMIN_LID=" + jid).catch(() => {});
  }
};

// ── Bot online ─────────────────────────────────────────────────────────────────
let _lastOnlineAt = 0;
const notifyBotOnline = async () => {
  const now = Date.now();
  if (now - _lastOnlineAt < 5 * 60 * 1000) return;
  _lastOnlineAt = now;
  const ts = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  await toStatusGroup("🟢 SatvikMeals Bot ONLINE\n🕐 " + ts);
};

// ── Business event notifications ───────────────────────────────────────────────
const notifyNewUser = async ({ phoneNumber, name, phone }) => {
  const text = "👤 NEW CUSTOMER\n\nName: " + name + "\nWhatsApp: " + phoneNumber + "\nPhone: " + (phone || phoneNumber) + "\nTime: " + new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  await Promise.allSettled([toEventsGroup(text), toTelegram(text)]);
};

const notifySubscriptionInterest = async ({ phoneNumber, planName, customerName, address }) => {
  const text = "📋 SUBSCRIPTION REQUEST\n\n👤 " + (customerName||"Unknown") + "\n📱 " + phoneNumber + "\n📦 " + planName + "\n📍 " + (address||"Not given") + "\n⚡ Action needed: confirm payment";
  await Promise.allSettled([toEventsGroup(text), toTelegram(text)]);
};

const notifyNewOrder = async ({ phoneNumber, customerName, address, item, amount }) => {
  const text = "🆕 NEW ORDER\n\n👤 " + customerName + "\n📱 " + phoneNumber + "\n🍱 " + item + "\n💰 Rs." + amount + "\n📍 " + (address||"Not given") + "\n✅ Awaiting UPI — 6201276506";
  await Promise.allSettled([toEventsGroup(text), toTelegram(text)]);
};

const notifyComplaint = async ({ phoneNumber, type, issue }) => {
  const text = "⚠️ " + (type||"COMPLAINT").toUpperCase() + "\n\n📱 " + phoneNumber + "\n\n" + issue;
  await Promise.allSettled([toEventsGroup(text), toTelegram(text)]);
};

const notifyHealthNote = async ({ phoneNumber, note }) => {
  const text = "🏥 HEALTH NOTE\n\n📱 " + phoneNumber + "\n\n" + note;
  await Promise.allSettled([toEventsGroup(text), toTelegram(text)]);
};

// ── Broadcast engine ───────────────────────────────────────────────────────────
const broadcast = async (phones, message, mediaUrl) => {
  if (!_sock) throw new Error("Socket not ready");
  let sent = 0, failed = 0;
  for (const phone of phones) {
    try {
      const digits = String(phone).replace(/\D/g, "").slice(-10);
      const jid    = "91" + digits + "@s.whatsapp.net";
      if (mediaUrl && /\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(mediaUrl)) {
        await _sock.sendMessage(jid, { image: { url: mediaUrl }, caption: message || "" });
      } else if (mediaUrl && /\.(mp4|mov|avi)(\?|$)/i.test(mediaUrl)) {
        await _sock.sendMessage(jid, { video: { url: mediaUrl }, caption: message || "" });
      } else {
        await _sock.sendMessage(jid, { text: message });
      }
      sent++;
      await new Promise(r => setTimeout(r, 1500));
    } catch (e) {
      console.error("[Broadcast] Failed " + phone + ": " + e.message);
      failed++;
    }
  }
  return { sent, failed };
};

// ── Blocked set ────────────────────────────────────────────────────────────────
const _blocked = new Set();
const isBlocked = (phone) => _blocked.has(phone);

// ── Help text ──────────────────────────────────────────────────────────────────
const HELP_TEXT =
"📱 SATVIKMEALS ADMIN PANEL\n\n" +
"INFO:\n" +
"!stats — summary\n" +
"!customers — all customers\n" +
"!customer 9876543210 — one profile\n" +
"!history 9876543210 — chat history\n" +
"!search <name/number> — find customer\n\n" +
"MESSAGING:\n" +
"!broadcast <msg> — text to all\n" +
"!broadcastimg <url> <caption> — image to all\n" +
"!send 9876543210 <msg> — text to one\n" +
"!sendimg 9876543210 <url> — image to one\n\n" +
"MANAGEMENT:\n" +
"!note 9876543210 <note> — add note\n" +
"!clear 9876543210 — clear history\n" +
"!block 9876543210 — block\n" +
"!unblock 9876543210 — unblock\n" +
"!unfreeze 9876543210 — return to bot\n\n" +
"AUTOMATION:\n" +
"!offer <msg> — offer to all\n" +
"!remind — run reminders\n" +
"!feedback — run feedback\n\n" +
"BOT:\n" +
"!status — uptime\n" +
"!ping — alive check";

// ── Handle admin command ───────────────────────────────────────────────────────
const handleAdminCommand = async (text, fromJid) => {
  if (!_Conversation) return false;
  const cmd = text.trim();
  if (!cmd.startsWith("!")) return false;

  // Track where to reply (DM or group)
  if (fromJid) _lastCommandSource = fromJid;

  if (/^!ping$/i.test(cmd)) {
    await replyToAdmin("🟢 Bot alive\nUptime: " + Math.floor(process.uptime() / 60) + " min");
    return true;
  }

  if (/^!help$/i.test(cmd)) {
    await replyToAdmin(HELP_TEXT);
    return true;
  }

  if (/^!status$/i.test(cmd)) {
    const h = Math.floor(process.uptime() / 3600), m = Math.floor((process.uptime() % 3600) / 60);
    const total = await _Conversation.countDocuments().catch(() => "?");
    await replyToAdmin("📊 BOT STATUS\n\nUptime: " + h + "h " + m + "m\nCustomers: " + total + "\nMemory: " + Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + "MB\nTime: " + new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }));
    return true;
  }

  if (/^!stats$/i.test(cmd)) {
    try {
      const total       = await _Conversation.countDocuments();
      const withOrders  = await _Conversation.countDocuments({ "profile.totalOrders": { $gt: 0 } });
      const withEmail   = await _Conversation.countDocuments({ "profile.email": { $nin: ["", null] } });
      const today       = new Date(); today.setHours(0,0,0,0);
      const activeToday = await _Conversation.countDocuments({ updatedAt: { $gte: today } });
      const recent      = await _Conversation.find({}, { phoneNumber: 1, "profile.name": 1, "profile.totalOrders": 1, updatedAt: 1 }).sort({ updatedAt: -1 }).limit(5).lean();
      const lines = ["📊 SATVIKMEALS STATS\n", "Total customers: " + total, "Active today: " + activeToday, "With orders: " + withOrders, "Registered (email): " + withEmail, "\nRecent 5:"];
      recent.forEach((c, i) => lines.push((i+1) + ". " + (c.profile?.name||"Unknown") + " — " + c.phoneNumber + " — " + (c.profile?.totalOrders||0) + " orders"));
      await replyToAdmin(lines.join("\n"));
    } catch (e) { await replyToAdmin("Error: " + e.message); }
    return true;
  }

  if (/^!customers$/i.test(cmd)) {
    try {
      const all = await _Conversation.find({}, { phoneNumber:1,"profile.name":1,"profile.email":1,"profile.totalOrders":1,"profile.lastPlanSeen":1,updatedAt:1 }).sort({ updatedAt: -1 }).lean();
      if (!all.length) { await replyToAdmin("No customers yet."); return true; }
      for (let i = 0; i < all.length; i += 20) {
        const chunk = all.slice(i, i + 20);
        const lines = ["👥 CUSTOMERS (" + (i+1) + "-" + (i+chunk.length) + " of " + all.length + "):\n"];
        chunk.forEach((c, j) => lines.push((i+j+1) + ". " + (c.profile?.name||"Unknown") + " — " + c.phoneNumber + (c.profile?.email ? " | " + c.profile.email : "") + (c.profile?.totalOrders ? " | " + c.profile.totalOrders + " orders" : "")));
        await replyToAdmin(lines.join("\n"));
        await new Promise(r => setTimeout(r, 500));
      }
    } catch (e) { await replyToAdmin("Error: " + e.message); }
    return true;
  }

  if (/^!customer\s+\d+/i.test(cmd)) {
    const phone = cmd.match(/\d{10}/)?.[0];
    if (!phone) { await replyToAdmin("Format: !customer 9876543210"); return true; }
    try {
      const doc = await _Conversation.findOne({ phoneNumber: phone }).lean();
      if (!doc) { await replyToAdmin("No customer found for " + phone); return true; }
      const p = doc.profile || {};
      await replyToAdmin("👤 CUSTOMER PROFILE\n\nName: " + (p.name||"Not set") + "\nPhone: " + (p.phone||phone) + "\nEmail: " + (p.email||"Not set") + "\nAddress: " + (p.address||"Not set") + "\nOrders: " + (p.totalOrders||0) + "\nLast Plan: " + (p.lastPlanSeen||"None") + "\nHealth: " + (p.healthNotes||"None") + "\nMeal Pref: " + (p.mealPreference||"standard") + "\nNote: " + (p.adminNote||"None") + "\nMessages: " + (doc.history?.length||0) + "\nBlocked: " + (_blocked.has(phone) ? "Yes" : "No") + "\nTransferred: " + (p.isTransferred ? "Yes" : "No") + "\nJoined: " + new Date(doc.createdAt).toLocaleString("en-IN",{timeZone:"Asia/Kolkata"}) + "\nLast active: " + new Date(doc.updatedAt).toLocaleString("en-IN",{timeZone:"Asia/Kolkata"}));
    } catch (e) { await replyToAdmin("Error: " + e.message); }
    return true;
  }

  if (/^!history\s+\d+/i.test(cmd)) {
    const phone = cmd.match(/\d{10}/)?.[0];
    if (!phone) { await replyToAdmin("Format: !history 9876543210"); return true; }
    try {
      const doc = await _Conversation.findOne({ phoneNumber: phone }).lean();
      if (!doc?.history?.length) { await replyToAdmin("No history for " + phone); return true; }
      const last = doc.history.slice(-10);
      const lines = ["💬 LAST " + last.length + " MESSAGES — " + (doc.profile?.name||phone) + "\n"];
      last.forEach(m => {
        const role = m.role === "user" ? "👤" : "🤖";
        const ts   = m.timestamp ? new Date(m.timestamp).toLocaleTimeString("en-IN") : "";
        lines.push(role + " " + ts + ":\n" + (m.content||"").slice(0, 200));
      });
      await replyToAdmin(lines.join("\n\n"));
    } catch (e) { await replyToAdmin("Error: " + e.message); }
    return true;
  }

  if (/^!search\s+/i.test(cmd)) {
    const query = cmd.replace(/^!search\s+/i, "").trim();
    try {
      const results = await _Conversation.find({ $or: [{ "profile.name": { $regex: query, $options: "i" } }, { phoneNumber: { $regex: query } }, { "profile.email": { $regex: query, $options: "i" } }] }, { phoneNumber:1,"profile.name":1,"profile.email":1,"profile.totalOrders":1 }).limit(10).lean();
      if (!results.length) { await replyToAdmin("No results for \"" + query + "\""); return true; }
      const lines = ["🔍 Results for \"" + query + "\":\n"];
      results.forEach((c,i) => lines.push((i+1) + ". " + (c.profile?.name||"Unknown") + " — " + c.phoneNumber + (c.profile?.email ? " — " + c.profile.email : "") + (c.profile?.totalOrders ? " — " + c.profile.totalOrders + " orders" : "")));
      await replyToAdmin(lines.join("\n"));
    } catch (e) { await replyToAdmin("Error: " + e.message); }
    return true;
  }

  if (/^!note\s+\d+/i.test(cmd)) {
    const match = cmd.match(/^!note\s+(\d{10})\s+([\s\S]+)/i);
    if (!match) { await replyToAdmin("Format: !note 9876543210 your note"); return true; }
    const [, phone, note] = match;
    try {
      await _Conversation.findOneAndUpdate({ phoneNumber: phone }, { $set: { "profile.adminNote": note, updatedAt: new Date() } });
      await replyToAdmin("✅ Note saved for " + phone + ": \"" + note + "\"");
    } catch (e) { await replyToAdmin("Error: " + e.message); }
    return true;
  }

  if (/^!clear\s+\d+/i.test(cmd)) {
    const phone = cmd.match(/\d{10}/)?.[0];
    if (!phone) { await replyToAdmin("Format: !clear 9876543210"); return true; }
    try {
      await _Conversation.findOneAndUpdate({ phoneNumber: phone }, { $set: { history: [], updatedAt: new Date() } });
      await replyToAdmin("✅ History cleared for " + phone);
    } catch (e) { await replyToAdmin("Error: " + e.message); }
    return true;
  }

  if (/^!block\s+\d+/i.test(cmd)) {
    const phone = cmd.match(/\d{10}/)?.[0];
    if (!phone) { await replyToAdmin("Format: !block 9876543210"); return true; }
    _blocked.add(phone);
    await replyToAdmin("🚫 " + phone + " is now blocked.");
    return true;
  }

  if (/^!unblock\s+\d+/i.test(cmd)) {
    const phone = cmd.match(/\d{10}/)?.[0];
    if (!phone) { await replyToAdmin("Format: !unblock 9876543210"); return true; }
    _blocked.delete(phone);
    await replyToAdmin("✅ " + phone + " is unblocked.");
    return true;
  }

  if (/^!unfreeze\s+\d+/i.test(cmd)) {
    const phone = cmd.match(/\d{10}/)?.[0];
    if (!phone) { await replyToAdmin("Format: !unfreeze 9876543210"); return true; }
    try {
      await _Conversation.findOneAndUpdate({ phoneNumber: phone }, { $set: { "profile.isTransferred": false, updatedAt: new Date() } });
      await replyToAdmin("✅ " + phone + " returned to bot.");
    } catch (e) { await replyToAdmin("Error: " + e.message); }
    return true;
  }

  // !send 9876543210 message
  if (/^!(send|reply)\s+\d+/i.test(cmd)) {
    const match = cmd.match(/^!(send|reply)\s+(\d{10})\s+([\s\S]+)/i);
    if (!match) { await replyToAdmin("Format: !send 9876543210 your message"); return true; }
    const [,, phone, message] = match;
    try {
      await _sock.sendMessage("91" + phone + "@s.whatsapp.net", { text: message.trim() });
      await replyToAdmin("✅ Sent to " + phone);
    } catch (e) { await replyToAdmin("❌ Failed: " + e.message); }
    return true;
  }

  // !sendimg 9876543210 https://url.com/img.jpg optional caption
  if (/^!sendimg\s+\d+/i.test(cmd)) {
    const parts = cmd.split(/\s+/);
    const phone = parts[1];
    const url   = parts[2];
    const caption = parts.slice(3).join(" ");
    if (!phone || !url) { await replyToAdmin("Format: !sendimg 9876543210 https://image.url caption here"); return true; }
    try {
      await _sock.sendMessage("91" + phone + "@s.whatsapp.net", { image: { url }, caption: caption || "" });
      await replyToAdmin("✅ Image sent to " + phone);
    } catch (e) { await replyToAdmin("❌ Failed: " + e.message); }
    return true;
  }

  // !broadcast message
  if (/^!broadcast\s+/i.test(cmd)) {
    const message = cmd.replace(/^!broadcast\s+/i, "").trim();
    if (!message) { await replyToAdmin("Format: !broadcast your message"); return true; }
    try {
      const phones = await require("./contextManager").getAllPhones();
      await replyToAdmin("📢 Broadcasting to " + phones.length + " customers...");
      const result = await broadcast(phones, message);
      await replyToAdmin("✅ Done! Sent: " + result.sent + " | Failed: " + result.failed);
      await toEventsGroup("📢 BROADCAST SENT\n\"" + message.slice(0,80) + "\"\nSent: " + result.sent + " | Failed: " + result.failed);
    } catch (e) { await replyToAdmin("❌ Error: " + e.message); }
    return true;
  }

  // !broadcastimg https://url.com/img.jpg caption here
  if (/^!broadcastimg\s+/i.test(cmd)) {
    const parts   = cmd.split(/\s+/);
    const url     = parts[1];
    const caption = parts.slice(2).join(" ");
    if (!url) { await replyToAdmin("Format: !broadcastimg https://image.url caption here"); return true; }
    try {
      const phones = await require("./contextManager").getAllPhones();
      await replyToAdmin("📢 Sending image to " + phones.length + " customers...");
      const result = await broadcast(phones, caption, url);
      await replyToAdmin("✅ Done! Sent: " + result.sent + " | Failed: " + result.failed);
    } catch (e) { await replyToAdmin("❌ Error: " + e.message); }
    return true;
  }

  // !offer message
  if (/^!offer\s+/i.test(cmd)) {
    const message = cmd.replace(/^!offer\s+/i, "").trim();
    if (!message) { await replyToAdmin("Format: !offer your offer message"); return true; }
    try {
      const phones = await require("./contextManager").getAllPhones();
      await replyToAdmin("🎉 Sending offer to " + phones.length + " customers...");
      const result = await broadcast(phones, "🎉 Special Offer from SatvikMeals!\n\n" + message + "\n\nOrder: 6201276506");
      await replyToAdmin("✅ Offer sent! Sent: " + result.sent + " | Failed: " + result.failed);
    } catch (e) { await replyToAdmin("❌ Error: " + e.message); }
    return true;
  }

  if (/^!remind$/i.test(cmd)) {
    try {
      const sched = require("./scheduler");
      await replyToAdmin("Running reminders...");
      await sched.runSubscriptionReminders();
      await replyToAdmin("✅ Reminders done.");
    } catch (e) { await replyToAdmin("Error: " + e.message); }
    return true;
  }

  if (/^!feedback$/i.test(cmd)) {
    try {
      const sched = require("./scheduler");
      await replyToAdmin("Running feedback collection...");
      await sched.runFeedbackCollection();
      await replyToAdmin("✅ Feedback requests sent.");
    } catch (e) { await replyToAdmin("Error: " + e.message); }
    return true;
  }

  if (cmd.startsWith("!")) {
    await replyToAdmin("Unknown command. Send !help to see all commands.");
    return true;
  }

  return false;
};

module.exports = {
  setSocket, setConversationModel,
  isAdminJid, learnAdminLid, isBlocked,
  handleAdminCommand,
  toDM, toStatusGroup, toEventsGroup, toEventsGroupImage,
  notifyBotOnline,
  notifyNewUser, notifySubscriptionInterest, notifyNewOrder,
  notifyComplaint, notifyHealthNote,
  broadcast,
};
