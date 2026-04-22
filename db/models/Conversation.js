const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema({
  role:      { type: String, enum: ["user", "assistant"] },
  content:   { type: String },
  timestamp: { type: Date, default: Date.now },
});

const conversationSchema = new mongoose.Schema({
  // Clean 10-digit phone number — always normalized before saving
  phoneNumber: { type: String, required: true, unique: true, index: true },

  // Rolling chat history — last 100 messages kept
  history: [messageSchema],

  // Permanent profile — survives history trims and bot restarts
  // Everything here is injected into the AI system prompt so it never forgets
  profile: {
    name:         { type: String, default: "" },
    phone:        { type: String, default: "" }, // stored explicitly so it can be sent to website API
    email:        { type: String, default: "" },
    address:      { type: String, default: "" },
    linkedUserId: { type: String, default: "" }, // website User._id once linked
    totalOrders:  { type: Number, default: 0 },
    lastOrderAt:  { type: Date },
    lastPlanSeen: { type: String, default: "" },
    healthNotes:  { type: String, default: "" },
  },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.models.BotConversation ||
  mongoose.model("BotConversation", conversationSchema);
