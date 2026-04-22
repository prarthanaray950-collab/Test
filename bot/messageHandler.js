/**
 * messageHandler.js
 *
 * Core pipeline for every incoming WhatsApp message:
 * 1. Normalize phone to clean 10-digit number
 * 2. Duplicate guard — block if same phone already being processed
 * 3. Load full history + profile from MongoDB
 * 4. Auto-store phone number in profile (so it's always available for registration)
 * 5. Send full context to AI
 * 6. Parse action blocks, execute side effects (register user, subscription, etc.)
 * 7. Save exchange atomically, send reply
 */

const { chat }  = require("./openrouter");
const ctx       = require("./contextManager");
const api       = require("./websiteApi");
const admin     = require("./adminNotifier");

const extractBlock = (text, tag) => {
  const m = text.match(new RegExp(`\\[${tag}\\]([\\s\\S]*?)\\[\\/${tag}\\]`));
  if (!m) return null;
  const body = m[1];
  return {
    get: (key) => { const r = body.match(new RegExp(`${key}:\\s*(.+)`)); return r ? r[1].trim() : ""; },
    raw: body.trim(),
  };
};

const cleanReply = (text) =>
  text
    .replace(/\[ORDER_CONFIRMED\][\s\S]*?\[\/ORDER_CONFIRMED\]/g, "")
    .replace(/\[REGISTER_USER\][\s\S]*?\[\/REGISTER_USER\]/g, "")
    .replace(/\[SUBSCRIPTION_INTEREST\][\s\S]*?\[\/SUBSCRIPTION_INTEREST\]/g, "")
    .replace(/\[COMPLAINT\][\s\S]*?\[\/COMPLAINT\]/g, "")
    .replace(/\[HEALTH_NOTE\][\s\S]*?\[\/HEALTH_NOTE\]/g, "")
    .trim();

const handleMessage = async (sock, rawJid, userText, pushName = "") => {
  const phoneNumber = ctx.normalizePhone(rawJid);
  console.log(`[IN]  ${phoneNumber}: ${userText.slice(0, 80)}`);

  // ── Duplicate message guard ────────────────────────────────────────────────
  // Blocks duplicate processing if WhatsApp delivers same message twice,
  // or if free AI model fires two response chunks for one message.
  if (ctx.isAlreadyProcessing(phoneNumber)) {
    console.warn(`[SKIP] ${phoneNumber}: duplicate message blocked`);
    return;
  }
  ctx.markProcessingStart(phoneNumber);

  try {
    // ── Load full history + profile ────────────────────────────────────────
    const { history, profile } = await ctx.getHistoryAndProfile(phoneNumber);

    // ── Auto-store phone number in profile ─────────────────────────────────
    // The customer's WhatsApp number IS their phone number.
    // We store it in the profile so the AI and registration flow always has it.
    if (!profile.phone) {
      await ctx.updateProfile(phoneNumber, { phone: phoneNumber });
      profile.phone = phoneNumber;
    }

    // ── Save push name only if no real name known yet ──────────────────────
    if (pushName && !profile.name) {
      await ctx.savePushNameIfNew(phoneNumber, pushName);
      profile.name = pushName;
    }

    // ── Get AI reply — full history + profile every time ───────────────────
    const aiReply = await chat(userText, history, profile);
    console.log(`[AI]  ${phoneNumber}: ${aiReply.slice(0, 100)}`);

    const cleanedReply = cleanReply(aiReply);

    // ── Save exchange atomically BEFORE sending ────────────────────────────
    // Saved before sending so if WhatsApp delivery fails, history is still correct.
    await ctx.appendExchange(phoneNumber, userText, cleanedReply);

    let orderDone = false;

    // ── REGISTER USER ──────────────────────────────────────────────────────
    const regBlock = extractBlock(aiReply, "REGISTER_USER");
    if (regBlock) {
      // Pull from block, fall back to profile, fall back to known phone
      const name  = regBlock.get("Name")  || profile.name  || "Customer";
      const phone = regBlock.get("Phone") || profile.phone || phoneNumber;
      const email = regBlock.get("Email") || profile.email || "";

      console.log(`[USER] Creating account: ${name} | ${phone} | ${email}`);

      try {
        // Create or update user on the website with all three fields
        const result = await api.findOrCreateUser({
          name, phone, email, source: "whatsapp_bot",
        });

        const userId = result?.user?._id || result?._id || result?.user?.id;

        // If we got a user ID back, also PATCH the user to ensure all fields are set
        // This handles cases where findOrCreate only created a minimal record
        if (userId) {
          try {
            await api.updateUser(userId, { name, phone, email });
            console.log(`[USER] ✅ Profile updated on website for userId: ${userId}`);
          } catch (ue) {
            console.warn(`[USER] ⚠️ updateUser failed: ${ue.message}`);
          }
          await ctx.updateProfile(phoneNumber, { name, phone, email, linkedUserId: String(userId) });
        } else {
          await ctx.updateProfile(phoneNumber, { name, phone, email });
        }

        console.log(`[USER] ✅ ${name} (${phone}) ${email}`);
      } catch (e) {
        console.warn(`[USER] ⚠️ ${e.message}`);
        // Still save to local profile even if website API failed
        await ctx.updateProfile(phoneNumber, { name, phone, email });
      }

      await admin.notifyNewUser({ phoneNumber, name, phone });
    }

    // ── ORDER CONFIRMED ────────────────────────────────────────────────────
    const orderBlock = extractBlock(aiReply, "ORDER_CONFIRMED");
    if (orderBlock) {
      const customerName = orderBlock.get("Name")    || profile.name    || "Unknown";
      const address      = orderBlock.get("Address") || profile.address || "";
      const item         = orderBlock.get("Item")    || "Tiffin";
      const amount       = parseInt(orderBlock.get("Amount").replace(/[^\d]/g, "")) || 0;

      try {
        await api.createOrder({
          phoneNumber,
          customerName, address,
          items:      [{ name: item, quantity: 1, price: amount }],
          totalAmount: amount,
          source:      "whatsapp_bot",
        });
        console.log(`[ORDER] ✅ ${customerName} Rs.${amount}`);
      } catch (e) {
        console.warn(`[ORDER] ⚠️ ${e.message}`);
      }

      await ctx.updateProfile(phoneNumber, { name: customerName, address });
      await ctx.recordOrder(phoneNumber);
      await admin.notifyNewOrder({ phoneNumber, customerName, address, item, amount });
      await ctx.trimHistoryAfterOrder(phoneNumber);
      orderDone = true;
    }

    // ── SUBSCRIPTION INTEREST ──────────────────────────────────────────────
    const subBlock = extractBlock(aiReply, "SUBSCRIPTION_INTEREST");
    if (subBlock) {
      const planName     = subBlock.get("Plan");
      const customerName = subBlock.get("Name")    || profile.name    || "";
      const address      = subBlock.get("Address") || profile.address || "";

      try {
        await api.createSubscriptionLead({
          phoneNumber, customerName, planName, address, source: "whatsapp_bot",
        });
        console.log(`[SUB] ✅ ${planName}`);
      } catch (e) {
        console.warn(`[SUB] ⚠️ ${e.message}`);
      }

      await ctx.updateProfile(phoneNumber, {
        name:         customerName || undefined,
        address:      address      || undefined,
        lastPlanSeen: planName,
      });
      await admin.notifySubscriptionInterest({ phoneNumber, planName, customerName, address });
    }

    // ── COMPLAINT ──────────────────────────────────────────────────────────
    const compBlock = extractBlock(aiReply, "COMPLAINT");
    if (compBlock) {
      const type  = compBlock.get("Type")  || "complaint";
      const issue = compBlock.get("Issue") || compBlock.raw;

      try {
        await api.submitComplaint({
          phoneNumber, name: profile.name || "Unknown", type, issue, source: "whatsapp_bot",
        });
        console.log(`[COMPLAINT] ✅`);
      } catch (e) {
        console.warn(`[COMPLAINT] ⚠️ ${e.message}`);
      }

      await admin.notifyComplaint({ phoneNumber, type, issue });
    }

    // ── HEALTH NOTE ────────────────────────────────────────────────────────
    const healthBlock = extractBlock(aiReply, "HEALTH_NOTE");
    if (healthBlock) {
      const note = healthBlock.get("Note") || healthBlock.raw;
      await ctx.updateProfile(phoneNumber, { healthNotes: note });
      await admin.notifyHealthNote({ phoneNumber, note });
      console.log(`[HEALTH] ✅`);
    }

    // ── Send reply ─────────────────────────────────────────────────────────
    if (cleanedReply) {
      await sock.sendMessage(rawJid, { text: cleanedReply });
      console.log(`[OUT] ${phoneNumber}: ${cleanedReply.slice(0, 80)}`);
    }

  } catch (err) {
    console.error(`[ERR] ${phoneNumber}: ${err.message}`);
    await sock.sendMessage(rawJid, {
      text: "Kuch technical issue aa gaya hai 🙏 Thodi der mein dobara try karein, ya seedha call karein: 6201276506",
    });
  } finally {
    // Always release the processing lock, even if something threw
    ctx.markProcessingDone(phoneNumber);
  }
};

module.exports = { handleMessage };
