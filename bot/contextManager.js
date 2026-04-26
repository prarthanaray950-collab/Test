const Conversation = require("../db/models/Conversation");

const HISTORY_LIMIT = 100;

const normalizePhone = (raw) => {
  const digits = String(raw).replace("@s.whatsapp.net","").replace(/\D/g,"");
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0"))  return digits.slice(1);
  return digits.slice(-10);
};

// ── Per-phone processing lock ─────────────────────────────────────────────────
// LOCK_TIMEOUT_MS must be LONGER than the maximum possible AI call duration.
// AI can try 4 models × 15s each + 3s delays = ~63s worst case.
// Set to 90s so the lock never auto-expires mid-processing.
// If a genuine crash happens, the lock will clear after 90s.
const _busy = new Map(); // phone -> timestamp
const LOCK_TIMEOUT_MS = 90000; // 90 seconds — longer than max AI time

const isAlreadyProcessing = (phone) => {
  const ts = _busy.get(phone);
  if (!ts) return false;
  if (Date.now() - ts > LOCK_TIMEOUT_MS) {
    console.warn("[CTX] Stale lock cleared for " + phone);
    _busy.delete(phone);
    return false;
  }
  return true;
};
const markProcessingStart = (phone) => _busy.set(phone, Date.now());
const markProcessingDone  = (phone) => _busy.delete(phone);
const clearAllLocks = () => {
  const count = _busy.size;
  _busy.clear();
  _queues.clear();
  _lastProcessed.clear();
  if (count > 0) console.log("[CTX] Cleared " + count + " stale lock(s) on reconnect.");
};

// ── Per-phone message queue ───────────────────────────────────────────────────
const _queues = new Map(); // phone -> [{ sock, rawJid, userText, pushName }]

const enqueue = (phone, item) => {
  if (!_queues.has(phone)) _queues.set(phone, []);
  const q = _queues.get(phone);
  // Drop if same text is already last in queue — prevents double-fire from WA duplicates
  if (q.length && q[q.length - 1].userText === item.userText) {
    console.log("[CTX] Duplicate queued msg dropped: " + phone + " — " + item.userText.slice(0,30));
    return;
  }
  q.push(item);
};
const dequeue = (phone) => {
  const q = _queues.get(phone);
  if (!q || !q.length) return null;
  const item = q.shift();
  if (q.length === 0) _queues.delete(phone);
  return item;
};
const hasQueued = (phone) => (_queues.get(phone)?.length || 0) > 0;

// ── Recently-processed dedup ──────────────────────────────────────────────────
// Tracks the last text processed per phone. If a queued duplicate fires right
// after completion, it sees it was just handled and exits without replying.
const _lastProcessed = new Map(); // phone -> { text, ts }
const PROC_DEDUP_MS  = 8000; // 8s window — covers AI response + network time

const wasJustProcessed = (phone, text) => {
  const last = _lastProcessed.get(phone);
  return !!(last && last.text === text && Date.now() - last.ts < PROC_DEDUP_MS);
};
const markJustProcessed = (phone, text) => {
  _lastProcessed.set(phone, { text, ts: Date.now() });
};

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
  const todayStart = new Date(); todayStart.setHours(0,0,0,0);
  try {
    return await Conversation.find({
      "profile.totalOrders": { $gt: 0 },
      $or: [
        { "profile.lastFeedbackAt": { $lt: todayStart } },
        { "profile.lastFeedbackAt": null },
        { "profile.lastFeedbackAt": { $exists: false } },
      ],
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
  isAlreadyProcessing, markProcessingStart, markProcessingDone, clearAllLocks,
  enqueue, dequeue, hasQueued,
  wasJustProcessed, markJustProcessed,
  getHistoryAndProfile, appendExchange, updateProfile,
  savePushNameIfNew, recordOrder, trimHistoryAfterOrder,
  getExpiringSubscriptions, getPendingFeedback, getAllPhones,
};
