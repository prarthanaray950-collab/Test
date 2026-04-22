/**
 * scheduler.js
 *
 * Runs background jobs on a timer:
 *
 * 1. SUBSCRIPTION REMINDERS — runs daily at 10 AM
 *    Finds customers whose plan expires in 1-2 days, sends WhatsApp reminder
 *
 * 2. FEEDBACK COLLECTION — runs daily at 9 PM (after dinner delivery)
 *    Asks customers who received a delivery today how their meal was
 *
 * 3. RENEWAL NOTIFICATIONS — runs daily at 9 AM
 *    Notifies admin of all plans expiring tomorrow
 */

const ctx   = require("./contextManager");
const admin = require("./adminNotifier");

let _sock = null;

const setSocket = (sock) => { _sock = sock; };

const sendToCustomer = async (phone, text) => {
  if (!_sock) return;
  try {
    const digits = String(phone).replace(/\D/g,"").slice(-10);
    await _sock.sendMessage(`91${digits}@s.whatsapp.net`, { text });
    console.log(`[Scheduler] Sent to ${digits}: ${text.slice(0,50)}`);
  } catch (e) {
    console.error(`[Scheduler] Failed ${phone}: ${e.message}`);
  }
};

// ── Job 1: Subscription reminders ────────────────────────────────────────────
const runSubscriptionReminders = async () => {
  console.log("[Scheduler] Running subscription reminders...");
  const expiring = await ctx.getExpiringSubscriptions(2);
  if (!expiring.length) { console.log("[Scheduler] No expiring subscriptions."); return; }

  for (const doc of expiring) {
    const name    = doc.profile?.name || "Valued Customer";
    const endDate = doc.profile?.subscriptionEndAt;
    const daysLeft = endDate
      ? Math.ceil((new Date(endDate) - Date.now()) / (1000 * 60 * 60 * 24))
      : null;

    const msg = daysLeft === 1
      ? `Namaste ${name} ji 🌿\n\nAapka SatvikMeals subscription kal expire ho raha hai.\n\nRenewal ke liye abhi payment karein aur uninterrupted fresh meals enjoy karein.\n\nPayment: UPI 6201276506 (GPay/PhonePe/Paytm)\nOr call: 6201276506\n\nDhanyavaad 🙏`
      : `Namaste ${name} ji 🌿\n\nAapka SatvikMeals subscription ${daysLeft} din mein expire hoga.\n\nSamay pe renewal karein taaki meals mein koi break na aaye.\n\nPayment: UPI 6201276506\nOr call: 6201276506`;

    await sendToCustomer(doc.phoneNumber, msg);
    await ctx.updateProfile(doc.phoneNumber, { reminderSentAt: new Date() });
    await new Promise(r => setTimeout(r, 2000));
  }

  await admin.toEventsGroup(
    `🔔 SUBSCRIPTION REMINDERS SENT\n\nSent to ${expiring.length} customer(s) expiring in 1-2 days`
  );
};

// ── Job 2: Feedback collection ────────────────────────────────────────────────
const runFeedbackCollection = async () => {
  console.log("[Scheduler] Running feedback collection...");
  const pending = await ctx.getPendingFeedback();
  if (!pending.length) { console.log("[Scheduler] No pending feedback."); return; }

  for (const doc of pending) {
    const name = doc.profile?.name || "Valued Customer";
    const msg  =
      `Namaste ${name} ji 🌿\n\n` +
      `Aaj ka khana kaisa laga? Aapka feedback humein aur behtar banata hai.\n\n` +
      `Kripya ek rating dein:\n` +
      `⭐ 1 - Bahut kharab\n` +
      `⭐⭐ 2 - Theek hai\n` +
      `⭐⭐⭐ 3 - Achha tha\n` +
      `⭐⭐⭐⭐ 4 - Bahut achha\n` +
      `⭐⭐⭐⭐⭐ 5 - Excellent!\n\n` +
      `Sirf number bhejein (1-5) ya apna feedback likhein 🙏`;

    await sendToCustomer(doc.phoneNumber, msg);
    await ctx.updateProfile(doc.phoneNumber, { lastFeedbackAt: new Date() });
    await new Promise(r => setTimeout(r, 2000));
  }
};

// ── Job 3: Admin renewal report ───────────────────────────────────────────────
const runRenewalReport = async () => {
  const expiring = await ctx.getExpiringSubscriptions(1);
  if (!expiring.length) return;
  const lines = [`📅 RENEWALS DUE TOMORROW\n`];
  expiring.forEach((d,i) => {
    lines.push(`${i+1}. ${d.profile?.name || "Unknown"} — ${d.phoneNumber}`);
  });
  await admin.toEventsGroup(lines.join("\n"));
};

// ── Scheduler runner — uses setInterval with IST time checks ─────────────────
let _started = false;

const start = () => {
  if (_started) return;
  _started = true;
  console.log("[Scheduler] Started.");

  // Check every 60 seconds
  setInterval(async () => {
    if (!_sock) return;

    const now = new Date();
    const istHour = (now.getUTCHours() + 5) % 24;
    const istMin  = (now.getUTCMinutes() + 30) % 60;

    // 10:00 AM IST — subscription reminders
    if (istHour === 10 && istMin === 0) {
      runSubscriptionReminders().catch(e => console.error("[Scheduler] Reminder error:", e.message));
    }

    // 9:00 AM IST — renewal report to admin
    if (istHour === 9 && istMin === 0) {
      runRenewalReport().catch(e => console.error("[Scheduler] Report error:", e.message));
    }

    // 9:00 PM IST — feedback collection
    if (istHour === 21 && istMin === 0) {
      runFeedbackCollection().catch(e => console.error("[Scheduler] Feedback error:", e.message));
    }

  }, 60 * 1000);
};

module.exports = { start, setSocket, sendToCustomer, runSubscriptionReminders, runFeedbackCollection, runRenewalReport };
