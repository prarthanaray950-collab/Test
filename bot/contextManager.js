const Conversation = require("../db/models/Conversation");

const HISTORY_LIMIT = 100;

const normalizePhone = (raw) => {
  const digits = String(raw).replace("@s.whatsapp.net","").replace(/\D/g,"");
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0"))  return digits.slice(1);
  return digits.slice(-10);
};

// ── Per-phone message queue ────────────────────────────────────────────────────
// Instead of dropping messages that arrive while bot is busy,
// we queue them and process in order. This prevents "stops replying"
// when user sends two messages quickly.
const _queues    = new Map(); // phone -> [{ text, rawJid, pushName, sock }]
const _busy      = new Map(); // phone -> timestamp when processing started

// Auto-clear stale locks after 45 seconds.
// This prevents the "bot stops responding" bug where a crash or connection drop
// leaves the lock permanently set, blocking all future messages from that number.
const LOCK_TIMEOUT_MS = 45000;

const isAlreadyProcessing = (phone) => {
  const ts = _busy.get(phone);
  if (!ts) return false;
  if (Date.now() - ts > LOCK_TIMEOUT_MS) {
    // Stale lock — clear it automatically
    console.warn("[CTX] Stale lock cleared for " + phone);
    _busy.delete(phone);
    return false;
  }
  return true;
};
const markProcessingStart = (phone) => _busy.set(phone, Date.now());
const markProcessingDone  = (phone) => _busy.delete(phone);

// Enqueue a message. Returns true if it was queued (caller should not process immediately).
const enqueue = (phone, item) => {
  if (!_queues.has(phone)) _queues.set(phone, []);
  _queues.get(phone).push(item);
};

// Dequeue next message for this phone. Returns item or null.
const dequeue = (phone) => {
  const q = _queues.get(phone);
  if (!q || !q.length) return null;
  const item = q.shift();
  if (q.length === 0) _queues.delete(phone);
  return item;
};

const hasQueued = (phone) => (_queues.get(phone)?.length || 0) > 0;

// ── Core DB helpers ───────────────────────────────────────────────────────────

const getHistoryAndProfile = async (phoneNumber) => {
  const phone = normalizePhone(phoneNumber);
  try {
    const doc = await Conversation.findOne({ phoneNumber: phone });
    return {
      history:   doc?.history?.slice(-HISTORY_LIMIT) || [],
      profile:   doc?.profile || {},
      isNewUser: !doc,
      createdAt: doc?.createdAt || null,
    };
  } catch (e) {
    console.error("[CTX] getHistoryAndProfile:", e.message);
    return { history: [], profile: {}, isNewUser: true, createdAt: null };
  }
};

const appendExchange = async (phoneNumber, userContent, assistantContent) => {
  const phone = normalizePhone(phoneNumber);
  try {
    const messages = [{ role: "user", content: userContent, timestamp: new Date() }];
    if (assistantContent) messages.push({ role: "assistant", content: assistantContent, timestamp: new Date() });
    await Conversation.findOneAndUpdate(
      { phoneNumber: phone },
      { $push: { history: { $each: messages } }, $set: { updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
      { upsert: true, new: true }
    );
  } catch (e) { console.error("[CTX] appendExchange:", e.message); }
};

const updateProfile = async (phoneNumber, data = {}) => {
  const phone = normalizePhone(phoneNumber);
  try {
    const set = { updatedAt: new Date() };
    const fields = ["name","phone","email","address","linkedUserId","lastPlanSeen",
                    "healthNotes","adminNote","mealPreference","lastOrderItems",
                    "lastFeedbackAt","subscriptionEndAt","reminderSentAt",
                    "isTransferred","deliveryZone","firstMessageSent"];
    for (const f of fields) {
      if (data[f] !== undefined && data[f] !== null) set[`profile.${f}`] = data[f];
    }
    await Conversation.findOneAndUpdate({ phoneNumber: phone }, { $set: set }, { upsert: true });
  } catch (e) { console.error("[CTX] updateProfile:", e.message); }
};

const savePushNameIfNew = async (phoneNumber, pushName) => {
  if (!pushName) return;
  const phone = normalizePhone(phoneNumber);
  try {
    await Conversation.findOneAndUpdate(
      { phoneNumber: phone, $or: [{ "profile.name": "" }, { "profile.name": null }] },
      { $set: { "profile.name": pushName, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
      { upsert: true }
    );
  } catch (e) { console.error("[CTX] savePushNameIfNew:", e.message); }
};

const recordOrder = async (phoneNumber, items = "") => {
  const phone = normalizePhone(phoneNumber);
  try {
    const set = { "profile.lastOrderAt": new Date(), updatedAt: new Date() };
    if (items) set["profile.lastOrderItems"] = items;
    await Conversation.findOneAndUpdate(
      { phoneNumber: phone },
      { $inc: { "profile.totalOrders": 1 }, $set: set },
      { upsert: true }
    );
  } catch (e) { console.error("[CTX] recordOrder:", e.message); }
};

const trimHistoryAfterOrder = async (phoneNumber) => {
  const phone = normalizePhone(phoneNumber);
  try {
    const doc = await Conversation.findOne({ phoneNumber: phone });
    if (!doc) return;
    await Conversation.findOneAndUpdate(
      { phoneNumber: phone },
      { $set: { history: doc.history.slice(-20), updatedAt: new Date() } }
    );
  } catch (e) { console.error("[CTX] trimHistoryAfterOrder:", e.message); }
};

const getExpiringSubscriptions = async (withinDays = 2) => {
  const now = new Date(), cutoff = new Date(now.getTime() + withinDays * 86400000);
  try {
    return await Conversation.find(
      { "profile.subscriptionEndAt": { $gte: now, $lte: cutoff } },
      { phoneNumber: 1, "profile.name": 1, "profile.subscriptionEndAt": 1 }
    ).lean();
  } catch (e) { return []; }
};

const getPendingFeedback = async () => {
  const twoHoursAgo = new Date(Date.now() - 2*60*60*1000);
  const todayStart  = new Date(); todayStart.setHours(0,0,0,0);
  try {
    return await Conversation.find({
      "profile.lastOrderAt": { $lte: twoHoursAgo },
      "profile.totalOrders": { $gt: 0 },
      $or: [{ "profile.lastFeedbackAt": { $lt: todayStart } }, { "profile.lastFeedbackAt": null }],
    }, { phoneNumber: 1, "profile.name": 1 }).lean();
  } catch (e) { return []; }
};

const getAllPhones = async () => {
  try {
    return (await Conversation.find({}, { phoneNumber: 1 }).lean()).map(d => d.phoneNumber).filter(Boolean);
  } catch (e) { return []; }
};

module.exports = {
  normalizePhone,
  isAlreadyProcessing, markProcessingStart, markProcessingDone,
  enqueue, dequeue, hasQueued,
  getHistoryAndProfile, appendExchange, updateProfile,
  savePushNameIfNew, recordOrder, trimHistoryAfterOrder,
  getExpiringSubscriptions, getPendingFeedback, getAllPhones,
};
