const { chat }  = require("./openrouter");
const ctx       = require("./contextManager");
const api       = require("./websiteApi");
const admin     = require("./adminNotifier");
const scheduler = require("./scheduler");

const extractBlock = (text, tag) => {
  const m = text.match(new RegExp(`\\[${tag}\\]([\\s\\S]*?)\\[\\/${tag}\\]`));
  if (!m) return null;
  const body = m[1];
  return {
    get: (key) => { const r = body.match(new RegExp(`${key}:\\s*(.+)`)); return r?.[1]?.trim() || ""; },
    raw: body.trim(),
  };
};
const hasBlock = (text, tag) => new RegExp(`\\[${tag}\\]`).test(text);

const ALL_TAGS = [
  "ORDER_CONFIRMED","REGISTER_USER","SUBSCRIPTION_INTEREST","FETCH_ACCOUNT",
  "UPDATE_PROFILE","CONFIRM_PAYMENT","CHANGE_PLAN","UPDATE_ADDRESS",
  "UPDATE_MEAL_PREF","PAUSE_SUBSCRIPTION","RESUME_SUBSCRIPTION","CANCEL_SUBSCRIPTION",
  "APPLY_COINS","COMPLAINT","HEALTH_NOTE","REQUEST_CALLBACK",
  "DAILY_ORDER","CUSTOM_ORDER","DELIVERY_APPROVED","DELIVERY_CHECK_NEEDED",
  "TRANSFER_TO_OWNER","FEEDBACK","SEND_WELCOME",
];
const cleanReply = (text) => {
  let t = text;
  for (const tag of ALL_TAGS) t = t.replace(new RegExp(`\\[${tag}\\][\\s\\S]*?\\[\\/${tag}\\]`,"g"),"");
  return t.trim();
};

const fetchAccountData = async (phoneNumber, profile) => {
  try {
    const [ordersRes, subRes, userRes] = await Promise.allSettled([
      api.getOrdersByPhone(phoneNumber),
      api.getSubscriptionByPhone(phoneNumber),
      api.getUserByPhone(phoneNumber),
    ]);
    const orders = ordersRes.status==="fulfilled" ? (ordersRes.value?.orders||ordersRes.value||[]) : [];
    const sub    = subRes.status==="fulfilled"   ? subRes.value   : null;
    const user   = userRes.status==="fulfilled"  ? userRes.value  : null;
    return {
      totalOrders:        Array.isArray(orders)?orders.length:0,
      orders:             Array.isArray(orders)?orders:[],
      activePlan:         sub?.plan?.name||sub?.planName||user?.activePlan||null,
      subscriptionStatus: sub?.status||null,
      coins:              user?.coins||user?.loyaltyCoins||0,
      deliveryAddress:    sub?.deliveryAddress||user?.address||null,
      mealPreference:     sub?.mealPreference||null,
      nextDelivery:       sub?.nextDeliveryDate||null,
      pausedUntil:        sub?.pausedUntil||null,
    };
  } catch (e) { console.error("[FETCH_ACCOUNT]",e.message); return null; }
};

const handleMessage = async (sock, rawJid, userText, pushName = "") => {
  const phoneNumber = ctx.normalizePhone(rawJid);
  console.log(`[IN]  ${phoneNumber}: ${userText.slice(0,80)}`);

  if (admin.isBlocked(phoneNumber)) { console.log(`[BLOCKED] ${phoneNumber}`); return; }

  // Queue-based flow: if already processing, enqueue and return.
  // The processQueue loop will pick it up immediately after current message finishes.
  if (ctx.isAlreadyProcessing(phoneNumber)) {
    ctx.enqueue(phoneNumber, { sock, rawJid, userText, pushName });
    console.log(`[QUEUED] ${phoneNumber}: "${userText.slice(0,40)}"`);
    return;
  }
  ctx.markProcessingStart(phoneNumber);

  try {
    const { history, profile, isNewUser } = await ctx.getHistoryAndProfile(phoneNumber);

    if (!profile.phone) {
      await ctx.updateProfile(phoneNumber, { phone: phoneNumber });
      profile.phone = phoneNumber;
    }
    if (pushName && !profile.name) {
      await ctx.savePushNameIfNew(phoneNumber, pushName);
      profile.name = pushName;
    }

    // If transferred to owner, just log and notify — don't auto-reply
    if (profile.isTransferred) {
      await ctx.appendExchange(phoneNumber, userText, "");
      await admin.toDM(
        `💬 MESSAGE FROM TRANSFERRED CUSTOMER\n\n` +
        `👤 ${profile.name||"Unknown"} — ${phoneNumber}\n\n${userText}`
      );
      console.log(`[TRANSFERRED] ${phoneNumber} — forwarded to admin`);
      return;
    }

    // ── Direct greeting handler — bypasses AI, sends welcome instantly ────────
    const greetRegex = /^(hi+|hello+|hey+|namaste|helo|start|menu|help|hii+|kya hai|who are you|kon ho)[\s!?.]*$/i;
    if (greetRegex.test(userText.trim())) {
      const logoUrl = process.env.LOGO_URL || "";
      if (logoUrl) {
        try { await sock.sendMessage(rawJid, { image: { url: logoUrl }, caption: "" }); } catch (_) {}
      }
      const isRet = (profile.totalOrders || 0) > 0;
      const fname = profile.name ? profile.name.split(" ")[0] : null;
      const gname = fname ? fname + " ji" : null;
      const welcomeText = isRet
        ? "Namaste" + (gname ? ", " + gname : "") + "! Wapas aaye — swagat hai \uD83C\uDF3F\n\n" +
          (profile.lastOrderItems ? "Aapka last order tha: " + profile.lastOrderItems + ". Dobara order karein?\n\n" : "") +
          "Aaj main kya kar sakta hoon:\n\n" +
          "1. Same order repeat karein\n" +
          "2. Aaj ka menu dekhein\n" +
          "3. Daily tiffin order karein (Rs.80/plate)\n" +
          "4. Monthly plan details\n" +
          "5. Mere orders aur account info\n" +
          "6. Subscription manage karein (pause/resume/cancel)\n" +
          "7. Offers aur discounts\n" +
          "8. Owner se baat karein\n\n" +
          "Bas number bhejein ya seedha poochiye \uD83C\uDF3F"
        : "Namaste" + (gname ? ", " + gname : "") + "! SatvikMeals mein aapka swagat hai \uD83C\uDF3F\n\n" +
          "Patna ka trusted pure vegetarian meal service. Ghar jaisa khana, fresh ingredients, daily delivery.\n\n" +
          "Main aapki kya madad kar sakta hoon:\n\n" +
          "1. Aaj ka menu dekhein\n" +
          "2. Daily tiffin order karein (Rs.80/plate)\n" +
          "3. Monthly plan lein\n" +
          "4. Delivery availability check karein\n" +
          "5. Mere orders aur account info\n" +
          "6. Subscription manage karein\n" +
          "7. Offers aur discounts\n" +
          "8. Owner se baat karein\n\n" +
          "Bas number bhejein ya seedha apna sawaal poochiye \uD83C\uDF3F";
      await ctx.appendExchange(phoneNumber, userText, welcomeText);
      await ctx.updateProfile(phoneNumber, { firstMessageSent: true });
      await sock.sendMessage(rawJid, { text: welcomeText });
      console.log("[WELCOME] Sent to " + phoneNumber);
      return;
    }

    // ── Menu choice 7 (offers) — handle directly ────────────────────────────
    if (/^7[\s.]*$/.test(userText.trim())) {
      const offersText =
        "SatvikMeals ke current offers \uD83C\uDF3F\n\n" +
        "1. Loyalty Coins: Har order pe coins earn karein — 1 coin = Rs.1 off (max 50%)\n" +
        "2. Referral: Dost ko refer karein, aapko aur unhe 100 coins milenge\n" +
        "3. Monthly plan: Free delivery + best value per meal\n\n" +
        "Coins balance dekhne ke liye option 5 bhejein \uD83C\uDF3F";
      await ctx.appendExchange(phoneNumber, userText, offersText);
      await sock.sendMessage(rawJid, { text: offersText });
      return;
    }

    let aiReply = await chat(userText, history, profile, null, isNewUser);
    console.log(`[AI]  ${phoneNumber}: ${aiReply.slice(0,100)}`);

    if (hasBlock(aiReply, "FETCH_ACCOUNT")) {
      const accountData = await fetchAccountData(phoneNumber, profile);
      aiReply = await chat(userText, history, profile, accountData, isNewUser);
    }

    const cleanedReply = cleanReply(aiReply);
    await ctx.appendExchange(phoneNumber, userText, cleanedReply);

    // ── SEND WELCOME IMAGE ─────────────────────────────────────────────────
    if (hasBlock(aiReply, "SEND_WELCOME")) {
      const logoUrl = process.env.LOGO_URL || "";
      if (logoUrl) {
        try {
          await sock.sendMessage(rawJid, { image: { url: logoUrl }, caption: "" });
        } catch (_) {}
      }
      await ctx.updateProfile(phoneNumber, { firstMessageSent: true });
    }

    // ── REGISTER USER ──────────────────────────────────────────────────────
    const regBlock = extractBlock(aiReply, "REGISTER_USER");
    if (regBlock) {
      const name  = regBlock.get("Name")  || profile.name  || "Customer";
      const phone = regBlock.get("Phone") || profile.phone || phoneNumber;
      const email = regBlock.get("Email") || profile.email || "";
      try {
        const result = await api.findOrCreateUser({ name, phone, email, source: "whatsapp_bot" });
        const userId = result?.user?._id || result?._id;
        if (userId) {
          try { await api.updateUser(userId, { name, phone, email }); } catch(_) {}
          await ctx.updateProfile(phoneNumber, { name, phone, email, linkedUserId: String(userId) });
        } else {
          await ctx.updateProfile(phoneNumber, { name, phone, email });
        }
      } catch (e) { console.warn(`[REGISTER] ⚠️ ${e.message}`); await ctx.updateProfile(phoneNumber,{name:regBlock.get("Name"),email:regBlock.get("Email")}); }
      await admin.notifyNewUser({ phoneNumber, name, phone });
    }

    // ── UPDATE PROFILE ─────────────────────────────────────────────────────
    const updProfileBlock = extractBlock(aiReply, "UPDATE_PROFILE");
    if (updProfileBlock) {
      const updates = {};
      const n = updProfileBlock.get("Name"), e = updProfileBlock.get("Email"), a = updProfileBlock.get("Address");
      if (n) updates.name = n; if (e) updates.email = e; if (a) updates.address = a;
      if (Object.keys(updates).length) {
        await ctx.updateProfile(phoneNumber, updates);
        if (profile.linkedUserId) try { await api.updateUser(profile.linkedUserId, updates); } catch(_) {}
        else try { await api.updateUserByPhone(phoneNumber, updates); } catch(_) {}
      }
    }

    // ── DAILY ORDER ────────────────────────────────────────────────────────
    const dailyBlock = extractBlock(aiReply, "DAILY_ORDER");
    if (dailyBlock) {
      const plates  = dailyBlock.get("Plates");
      const meals   = dailyBlock.get("Meals");
      const days    = dailyBlock.get("Days");
      const address = dailyBlock.get("Address") || profile.address || "";
      const amount  = dailyBlock.get("Amount");
      try {
        await api.createOrder({
          phoneNumber, customerName: profile.name || "Customer",
          address, orderType: "daily_tiffin",
          items: [{ name: `Daily Tiffin (${meals})`, quantity: parseInt(plates)||1, price: 80 }],
          totalAmount: parseInt(amount) || 80,
          days, source: "whatsapp_bot",
        });
      } catch (e) { console.warn(`[DAILY_ORDER] ⚠️ ${e.message}`); }
      await ctx.recordOrder(phoneNumber, `Daily tiffin x${plates} (${meals}) for ${days}`);
      await admin.notifyNewOrder({
        phoneNumber, customerName: profile.name || "Customer",
        address, item: `Daily Tiffin x${plates} (${meals}) for ${days}`,
        amount: parseInt(amount)||80,
      });
    }

    // ── CUSTOM ORDER ───────────────────────────────────────────────────────
    const customBlock = extractBlock(aiReply, "CUSTOM_ORDER");
    if (customBlock) {
      const request = customBlock.get("Request") || customBlock.raw;
      await admin.toEventsGroup(
        `🍽 CUSTOM ORDER REQUEST\n\n` +
        `👤 ${profile.name||"Unknown"}\n📱 ${phoneNumber}\n\nRequest: ${request}`
      );
      await admin.toDM(
        `🍽 CUSTOM ORDER — ACTION NEEDED\n\n` +
        `👤 ${profile.name||"Unknown"} — ${phoneNumber}\n\n${request}\n\n` +
        `Reply to this customer: !send ${phoneNumber} your message`
      );
    }

    // ── DELIVERY CHECK ─────────────────────────────────────────────────────
    const delivApproved = extractBlock(aiReply, "DELIVERY_APPROVED");
    if (delivApproved) {
      const area = delivApproved.get("Area");
      await ctx.updateProfile(phoneNumber, { deliveryZone: "approved" });
      console.log(`[DELIVERY] ✅ Approved: ${area}`);
    }

    const delivCheck = extractBlock(aiReply, "DELIVERY_CHECK_NEEDED");
    if (delivCheck) {
      const area = delivCheck.get("Area");
      await ctx.updateProfile(phoneNumber, { deliveryZone: "pending_approval" });
      await admin.toDM(
        `📍 DELIVERY APPROVAL NEEDED\n\n` +
        `👤 ${profile.name||"Unknown"} — ${phoneNumber}\n` +
        `Area: ${area}\n\n` +
        `Approve: !send ${phoneNumber} Aapke area mein delivery available hai ✅\n` +
        `Decline: !send ${phoneNumber} Aapke area mein abhi delivery available nahi hai.`
      );
      await admin.toEventsGroup(`📍 DELIVERY CHECK\n\n👤 ${profile.name||"Unknown"} — ${phoneNumber}\nArea: ${area}`);
    }

    // ── TRANSFER TO OWNER ──────────────────────────────────────────────────
    const transferBlock = extractBlock(aiReply, "TRANSFER_TO_OWNER");
    if (transferBlock) {
      const reason = transferBlock.get("Reason") || "Customer requested";
      await ctx.updateProfile(phoneNumber, { isTransferred: true });
      await admin.toDM(
        `🔴 CUSTOMER WANTS TO TALK TO YOU\n\n` +
        `👤 ${profile.name||"Unknown"} — ${phoneNumber}\n` +
        `Reason: ${reason}\n\n` +
        `Reply directly: !send ${phoneNumber} Namaste! Main owner bol raha hoon...`
      );
      await admin.toEventsGroup(`🔴 TRANSFER TO OWNER\n\n👤 ${profile.name||"Unknown"} — ${phoneNumber}\nReason: ${reason}`);
    }

    // ── FEEDBACK ───────────────────────────────────────────────────────────
    const feedbackBlock = extractBlock(aiReply, "FEEDBACK");
    if (feedbackBlock) {
      const rating  = feedbackBlock.get("Rating");
      const comment = feedbackBlock.get("Comment") || feedbackBlock.raw;
      await ctx.updateProfile(phoneNumber, { lastFeedbackAt: new Date() });
      await admin.toEventsGroup(
        `⭐ FEEDBACK RECEIVED\n\n` +
        `👤 ${profile.name||"Unknown"} — ${phoneNumber}\n` +
        `Rating: ${rating || "N/A"}/5\nComment: ${comment}`
      );
    }

    // ── SUBSCRIPTION INTEREST ──────────────────────────────────────────────
    const subBlock = extractBlock(aiReply, "SUBSCRIPTION_INTEREST");
    if (subBlock) {
      const planName = subBlock.get("Plan"), customerName = subBlock.get("Name")||profile.name||"", address = subBlock.get("Address")||profile.address||"";
      try { await api.createSubscriptionLead({ phoneNumber, customerName, planName, address, source: "whatsapp_bot" }); } catch(e) { console.warn(`[SUB] ⚠️ ${e.message}`); }
      await ctx.updateProfile(phoneNumber, { name: customerName||undefined, address: address||undefined, lastPlanSeen: planName });
      await admin.notifySubscriptionInterest({ phoneNumber, planName, customerName, address });
    }

    // ── CONFIRM PAYMENT ────────────────────────────────────────────────────
    const payBlock = extractBlock(aiReply, "CONFIRM_PAYMENT");
    if (payBlock) {
      const amount = payBlock.get("Amount"), ref = payBlock.get("Reference")||payBlock.get("UPI")||"";
      try { await api.confirmPayment({ phoneNumber, name: profile.name, amount, reference: ref, source: "whatsapp_bot" }); } catch(_) {}
      await admin.toEventsGroup(`💰 PAYMENT CONFIRMED\n\n👤 ${profile.name||"Unknown"}\n📱 ${phoneNumber}\nAmount: Rs.${amount}\nRef: ${ref||"Not given"}`);
    }

    // ── CHANGE PLAN ────────────────────────────────────────────────────────
    const changePlanBlock = extractBlock(aiReply, "CHANGE_PLAN");
    if (changePlanBlock) {
      const newPlan = changePlanBlock.get("Plan");
      try { await api.changePlan({ phoneNumber, planName: newPlan, name: profile.name }); } catch(_) {}
      await ctx.updateProfile(phoneNumber, { lastPlanSeen: newPlan });
      await admin.toEventsGroup(`🔄 PLAN CHANGE\n\n👤 ${profile.name||"Unknown"} — ${phoneNumber}\nNew Plan: ${newPlan}`);
    }

    // ── UPDATE ADDRESS ─────────────────────────────────────────────────────
    const addrBlock = extractBlock(aiReply, "UPDATE_ADDRESS");
    if (addrBlock) {
      const address = addrBlock.get("Address");
      if (address) {
        await ctx.updateProfile(phoneNumber, { address });
        try { await api.updateDeliveryAddress({ phoneNumber, address, name: profile.name }); } catch(_) {}
      }
    }

    // ── UPDATE MEAL PREF ───────────────────────────────────────────────────
    const prefBlock = extractBlock(aiReply, "UPDATE_MEAL_PREF");
    if (prefBlock) {
      const pref = prefBlock.get("Preference");
      await ctx.updateProfile(phoneNumber, { mealPreference: pref });
      try { await api.updateMealPreference({ phoneNumber, preference: pref, name: profile.name }); } catch(_) {}
      await admin.toEventsGroup(`🍽 MEAL PREF\n\n👤 ${profile.name||"Unknown"} — ${phoneNumber}\nPref: ${pref}`);
    }

    // ── PAUSE / RESUME / CANCEL ────────────────────────────────────────────
    const pauseBlock = extractBlock(aiReply, "PAUSE_SUBSCRIPTION");
    if (pauseBlock) {
      const until = pauseBlock.get("Until");
      try { await api.pauseSubscription({ phoneNumber, name: profile.name, pauseUntil: until }); } catch(_) {}
      await admin.toEventsGroup(`⏸ PAUSED\n\n👤 ${profile.name||"Unknown"} — ${phoneNumber}${until?`\nUntil: ${until}`:""}`);
    }

    const resumeBlock = extractBlock(aiReply, "RESUME_SUBSCRIPTION");
    if (resumeBlock) {
      try { await api.resumeSubscription({ phoneNumber, name: profile.name }); } catch(_) {}
      await admin.toEventsGroup(`▶️ RESUMED\n\n👤 ${profile.name||"Unknown"} — ${phoneNumber}`);
    }

    const cancelBlock = extractBlock(aiReply, "CANCEL_SUBSCRIPTION");
    if (cancelBlock) {
      const reason = cancelBlock.get("Reason")||"Not given";
      try { await api.cancelSubscription({ phoneNumber, name: profile.name, reason }); } catch(_) {}
      await admin.toEventsGroup(`❌ CANCELLED\n\n👤 ${profile.name||"Unknown"} — ${phoneNumber}\nReason: ${reason}`);
    }

    // ── APPLY COINS ────────────────────────────────────────────────────────
    const coinsBlock = extractBlock(aiReply, "APPLY_COINS");
    if (coinsBlock) {
      const coins = coinsBlock.get("Coins")||coinsBlock.get("Amount");
      try { await api.applyCoins({ phoneNumber, coins, name: profile.name }); } catch(_) {}
    }

    // ── COMPLAINT ──────────────────────────────────────────────────────────
    const compBlock = extractBlock(aiReply, "COMPLAINT");
    if (compBlock) {
      const type = compBlock.get("Type")||"complaint", issue = compBlock.get("Issue")||compBlock.raw;
      try { await api.submitComplaint({ phoneNumber, name: profile.name||"Unknown", type, issue, source: "whatsapp_bot" }); } catch(_) {}
      await admin.notifyComplaint({ phoneNumber, type, issue });
    }

    // ── HEALTH NOTE ────────────────────────────────────────────────────────
    const healthBlock = extractBlock(aiReply, "HEALTH_NOTE");
    if (healthBlock) {
      const note = healthBlock.get("Note")||healthBlock.raw;
      await ctx.updateProfile(phoneNumber, { healthNotes: note });
      try { await api.updateMealPreference({ phoneNumber, healthNote: note, name: profile.name }); } catch(_) {}
      await admin.notifyHealthNote({ phoneNumber, note });
    }

    // ── REQUEST CALLBACK ───────────────────────────────────────────────────
    const callbackBlock = extractBlock(aiReply, "REQUEST_CALLBACK");
    if (callbackBlock) {
      const reason = callbackBlock.get("Reason")||"Not given", time = callbackBlock.get("Time")||"Any time";
      try { await api.requestCallback({ phoneNumber, name: profile.name, reason, preferredTime: time }); } catch(_) {}
      await admin.toEventsGroup(`📞 CALLBACK\n\n👤 ${profile.name||"Unknown"} — ${phoneNumber}\nReason: ${reason}\nTime: ${time}`);
      await admin.toDM(`📞 CALLBACK REQUEST\n\n👤 ${profile.name||"Unknown"} — ${phoneNumber}\nReason: ${reason}\nPreferred: ${time}\n\nReply: !send ${phoneNumber} your message`);
    }

    // ── ORDER CONFIRMED (legacy single order) ──────────────────────────────
    const orderBlock = extractBlock(aiReply, "ORDER_CONFIRMED");
    if (orderBlock) {
      const customerName = orderBlock.get("Name")||profile.name||"Unknown";
      const address = orderBlock.get("Address")||profile.address||"";
      const item = orderBlock.get("Item")||"Tiffin";
      const amount = parseInt(orderBlock.get("Amount").replace(/[^\d]/g,""))||0;
      try {
        await api.createOrder({ phoneNumber, customerName, address, items:[{name:item,quantity:1,price:amount}], totalAmount:amount, source:"whatsapp_bot" });
      } catch(e) { console.warn(`[ORDER] ⚠️ ${e.message}`); }
      await ctx.updateProfile(phoneNumber, { name: customerName, address });
      await ctx.recordOrder(phoneNumber, item);
      await admin.notifyNewOrder({ phoneNumber, customerName, address, item, amount });
      await ctx.trimHistoryAfterOrder(phoneNumber);
    }

    // ── Send reply ─────────────────────────────────────────────────────────
    if (cleanedReply) {
      await sock.sendMessage(rawJid, { text: cleanedReply });
      console.log(`[OUT] ${phoneNumber}: ${cleanedReply.slice(0,80)}`);
    }

  } catch (err) {
    console.error(`[ERR] ${phoneNumber}: ${err.message}`);
    await sock.sendMessage(rawJid, {
      text: "Kuch technical issue aa gaya hai 🙏 Thodi der mein try karein ya call karein: 6201276506",
    });
  } finally {
    ctx.markProcessingDone(phoneNumber);
    // Process next queued message for this phone if any
    if (ctx.hasQueued(phoneNumber)) {
      const next = ctx.dequeue(phoneNumber);
      if (next) {
        setImmediate(() =>
          handleMessage(next.sock, next.rawJid, next.userText, next.pushName)
            .catch(e => console.error(`[QUEUE_ERR] ${phoneNumber}: ${e.message}`))
        );
      }
    }
  }
};

module.exports = { handleMessage };
