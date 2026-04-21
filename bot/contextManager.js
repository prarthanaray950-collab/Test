const Conversation = require("../db/models/Conversation");

const HISTORY_LIMIT = 60; // 30 back-and-forth turns = large memory

const getHistoryAndProfile = async (phoneNumber) => {
  try {
    const doc = await Conversation.findOne({ phoneNumber });
    return {
      history: doc?.history?.slice(-HISTORY_LIMIT) || [],
      profile: doc?.profile || {},
    };
  } catch (e) {
    console.error("[CTX] getHistoryAndProfile:", e.message);
    return { history: [], profile: {} };
  }
};

const appendMessage = async (phoneNumber, role, content) => {
  try {
    await Conversation.findOneAndUpdate(
      { phoneNumber },
      {
        $push: { history: { role, content, timestamp: new Date() } },
        $set:  { updatedAt: new Date() },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true, new: true }
    );
  } catch (e) {
    console.error("[CTX] appendMessage:", e.message);
  }
};

const updateProfile = async (phoneNumber, data = {}) => {
  try {
    const set = { updatedAt: new Date() };
    if (data.name)         set["profile.name"]         = data.name;
    if (data.email)        set["profile.email"]        = data.email;
    if (data.address)      set["profile.address"]      = data.address;
    if (data.linkedUserId) set["profile.linkedUserId"] = data.linkedUserId;
    if (data.lastPlanSeen) set["profile.lastPlanSeen"] = data.lastPlanSeen;
    if (data.healthNotes)  set["profile.healthNotes"]  = data.healthNotes;
    await Conversation.findOneAndUpdate({ phoneNumber }, { $set: set }, { upsert: true });
  } catch (e) {
    console.error("[CTX] updateProfile:", e.message);
  }
};

const recordOrder = async (phoneNumber) => {
  try {
    await Conversation.findOneAndUpdate(
      { phoneNumber },
      {
        $inc: { "profile.totalOrders": 1 },
        $set: { "profile.lastOrderAt": new Date(), updatedAt: new Date() },
      },
      { upsert: true }
    );
  } catch (e) {
    console.error("[CTX] recordOrder:", e.message);
  }
};

// Clears chat history but KEEPS the profile
const clearHistory = async (phoneNumber) => {
  try {
    await Conversation.findOneAndUpdate(
      { phoneNumber },
      { $set: { history: [], updatedAt: new Date() } }
    );
  } catch (e) {
    console.error("[CTX] clearHistory:", e.message);
  }
};

module.exports = {
  getHistoryAndProfile,
  appendMessage,
  updateProfile,
  recordOrder,
  clearHistory,
};
