const Conversation = require("../db/models/Conversation");

const HISTORY_LIMIT = 100;

const normalizePhone = (raw) => {
  const digits = String(raw).replace("@s.whatsapp.net","").replace(/\D/g,"");
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0"))  return digits.slice(1);
  return digits.slice(-10);
};

const _processing = new Set();
const isAlreadyProcessing = (p) => _processing.has(p);
const markProcessingStart = (p) => _processing.add(p);
const markProcessingDone  = (p) => _processing.delete(p);

const getHistoryAndProfile = async (phoneNumber) => {
  const phone = normalizePhone(phoneNumber);
  try {
    const doc = await Conversation.findOne({ phoneNumber: phone });
    return {
      history:   doc?.history?.slice(-HISTORY_LIMIT) || [],
      profile:   doc?.profile || {},
      isNewUser: !doc,                             // true if first ever message
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

// Get all customers whose subscription ends within N days (for reminders)
const getExpiringSubscriptions = async (withinDays = 2) => {
  const now    = new Date();
  const cutoff = new Date(now.getTime() + withinDays * 24 * 60 * 60 * 1000);
  try {
    return await Conversation.find({
      "profile.subscriptionEndAt": { $gte: now, $lte: cutoff },
    }, { phoneNumber: 1, "profile.name": 1, "profile.subscriptionEndAt": 1 }).lean();
  } catch (e) { return []; }
};

// Get customers who received their last delivery >2 hours ago but haven't been asked for feedback today
const getPendingFeedback = async () => {
  const twoHoursAgo  = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const todayStart   = new Date(); todayStart.setHours(0,0,0,0);
  try {
    return await Conversation.find({
      "profile.lastOrderAt":   { $lte: twoHoursAgo },
      "profile.totalOrders":   { $gt: 0 },
      $or: [
        { "profile.lastFeedbackAt": { $lt: todayStart } },
        { "profile.lastFeedbackAt": null },
      ],
    }, { phoneNumber: 1, "profile.name": 1 }).lean();
  } catch (e) { return []; }
};

// Get all customers (for broadcast)
const getAllPhones = async () => {
  try {
    const all = await Conversation.find({}, { phoneNumber: 1 }).lean();
    return all.map(d => d.phoneNumber).filter(Boolean);
  } catch (e) { return []; }
};

module.exports = {
  normalizePhone,
  isAlreadyProcessing, markProcessingStart, markProcessingDone,
  getHistoryAndProfile,
  appendExchange,
  updateProfile,
  savePushNameIfNew,
  recordOrder,
  trimHistoryAfterOrder,
  getExpiringSubscriptions,
  getPendingFeedback,
  getAllPhones,
};
