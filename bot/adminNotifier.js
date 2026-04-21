let _sock = null;

const setSocket = (sock) => { _sock = sock; };

const notify = async (text) => {
  if (!_sock) return;
  try {
    const adminNum = (process.env.ADMIN_WHATSAPP || "919031447621").replace(/\D/g, "");
    await _sock.sendMessage(`${adminNum}@s.whatsapp.net`, { text });
    console.log(`[Admin] Notified: ${text.slice(0, 60)}`);
  } catch (err) {
    console.error("[Admin] Notify failed:", err.message);
  }
};

const notifyNewOrder = ({ phoneNumber, customerName, address, item, amount }) => {
  const time = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  return notify(`🍱 NEW ORDER (Bot)\n\n👤 ${customerName}\n📱 ${phoneNumber.replace("@s.whatsapp.net","")}\n📍 ${address}\n🛒 ${item}\n💰 Rs. ${amount}\n🕐 ${time}`);
};

const notifyNewUser = ({ phoneNumber, name, phone }) => {
  const time = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  return notify(`👤 NEW USER (Bot)\n\nName: ${name}\nPhone: ${phone}\nTime: ${time}`);
};

const notifyComplaint = ({ phoneNumber, issue }) => {
  const time = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  return notify(`⚠️ COMPLAINT (Bot)\n\n📱 ${phoneNumber.replace("@s.whatsapp.net","")}\n💬 ${issue}\n🕐 ${time}`);
};

const notifySubscriptionInterest = ({ phoneNumber, planName }) => {
  const time = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  return notify(`📋 SUBSCRIPTION INTEREST (Bot)\n\n📱 ${phoneNumber.replace("@s.whatsapp.net","")}\nPlan: ${planName}\n🕐 ${time}`);
};

module.exports = { setSocket, notify, notifyNewOrder, notifyNewUser, notifyComplaint, notifySubscriptionInterest };
