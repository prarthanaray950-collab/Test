const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema({
  role:      { type: String, enum: ["user", "assistant"] },
  content:   { type: String },
  timestamp: { type: Date, default: Date.now },
});

const conversationSchema = new mongoose.Schema({
  phoneNumber: { type: String, required: true, unique: true, index: true },

  // Rolling chat history — last 60 messages kept
  history: [messageSchema],

  // Permanent profile — survives history clears, lives across all sessions
  profile: {
    name:         { type: String, default: "" },
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
