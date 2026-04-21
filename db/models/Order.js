const mongoose = require("mongoose");

const orderSchema = new mongoose.Schema({
  phoneNumber:  { type: String, required: true },
  customerName: { type: String, default: "Unknown" },
  address:      { type: String, default: "" },
  items:        [String],
  totalAmount:  { type: Number, default: 0 },
  status:       { type: String, default: "pending" },
}, { timestamps: true });

module.exports = mongoose.models.BotOrder || mongoose.model("BotOrder", orderSchema);
