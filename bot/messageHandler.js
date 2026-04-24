const { chat }  = require("./openrouter");
const ctx       = require("./contextManager");
const api       = require("./websiteApi");
const admin     = require("./adminNotifier");

// ── Block helpers ──────────────────────────────────────────────────────────────
const extractBlock = (text, tag) => {
  const m = text.match(new RegExp("\\[" + tag + "\\]([\\s\\S]*?)\\[\\/" + tag + "\\]"));
  if (!m) return null;
  const body = m[1];
  return {
    get: (key) => { const r = body.match(new RegExp(key + ":\\s*(.+)")); return r ? r[1].trim() : ""; },
    raw: body.trim(),
  };
};
const hasBlock = (text, tag) => text.includes("[" + tag + "]");
const ALL_TAGS = ["ORDER_CONFIRMED","REGISTER_USER","SUBSCRIPTION_INTEREST","FETCH_ACCOUNT","UPDATE_PROFILE","CONFIRM_PAYMENT","CHANGE_PLAN","UPDATE_ADDRESS","UPDATE_MEAL_PREF","PAUSE_SUBSCRIPTION","RESUME_SUBSCRIPTION","CANCEL_SUBSCRIPTION","APPLY_COINS","COMPLAINT","HEALTH_NOTE","REQUEST_CALLBACK","DAILY_ORDER","CUSTOM_ORDER","DELIVERY_APPROVED","DELIVERY_CHECK_NEEDED","TRANSFER_TO_OWNER","FEEDBACK","SEND_WELCOME"];
const cleanReply = (text) => {
  let t = text;
  for (const tag of ALL_TAGS) t = t.replace(new RegExp("\\[" + tag + "\\][\\s\\S]*?\\[\\/" + tag + "\\]","g"),"");
  return t.trim();
};

// ── Fetch live account data ────────────────────────────────────────────────────
const fetchAccountData = async (phoneNumber) => {
  try {
    const [ordersRes, subRes, userRes] = await Promise.allSettled([
      api.getOrdersByPhone(phoneNumber),
      api.getSubscriptionByPhone(phoneNumber),
      api.getUserByPhone(phoneNumber),
    ]);
    const orders = ordersRes.status === "fulfilled" ? (ordersRes.value?.orders || ordersRes.value || []) : [];
    const sub    = subRes.status  === "fulfilled"   ? subRes.value   : null;
    const user   = userRes.status === "fulfilled"   ? userRes.value  : null;
    return {
      totalOrders: Array.isArray(orders) ? orders.length : 0,
      orders:      Array.isArray(orders) ? orders : [],
      activePlan:         sub?.plan?.name || sub?.planName || user?.activePlan || null,
      subscriptionStatus: sub?.status || null,
      subscriptionId:     sub?._id || sub?.id || null,
      coins:              user?.coins || user?.loyaltyCoins || 0,
      deliveryAddress:    sub?.deliveryAddress || user?.address || null,
      mealPreference:     sub?.mealPreference || null,
      nextDelivery:       sub?.nextDeliveryDate || null,
      pausedUntil:        sub?.pausedUntil || null,
    };
  } catch (e) {
    console.error("[FETCH_ACCOUNT]", e.message);
    return null;
  }
};

// ── Format orders for display ──────────────────────────────────────────────────
const formatOrdersReply = (accountData, profile) => {
  const name  = profile.name ? profile.name.split(" ")[0] + " ji" : "Aap";
  const coins = accountData.coins || 0;

  if (!accountData.orders || !accountData.orders.length) {
    const sub = accountData.activePlan;
    if (sub) {
      return "\uD83D\uDCE6 " + name + " ka account\n\n" +
        "Active Plan: " + sub + "\n" +
        "Status: " + (accountData.subscriptionStatus || "Active") + "\n" +
        "Loyalty Coins: " + coins + "\n\n" +
        "Abhi tak koi single order nahi hai.\n\n" +
        "1. Aaj ka tiffin order karein (Rs.80)\n" +
        "2. Subscription details\n" +
        "3. Back to menu";
    }
    return "\uD83D\uDCE6 " + name + " ke orders\n\nAbhi tak koi order nahi hai.\n\nPehla order place karein:\n\n1. Daily tiffin (Rs.80/plate)\n2. Monthly plan dekhein\n3. Back to menu";
  }

  const lines = ["\uD83D\uDCE6 " + name + " ke orders (" + accountData.orders.length + ")"];
  if (accountData.activePlan) {
    lines.push("\nActive Plan: " + accountData.activePlan + " (" + (accountData.subscriptionStatus || "active") + ")");
    if (accountData.nextDelivery) lines.push("Next delivery: " + accountData.nextDelivery);
  }
  lines.push("\nRecent orders:");
  accountData.orders.slice(0, 4).forEach((o, i) => {
    const date   = o.createdAt ? o.createdAt.slice(0, 10) : "?";
    const item   = o.items ? o.items.map(x => x.name).join(", ") : (o.item || "Tiffin");
    const status = o.status || o.paymentStatus || "pending";
    const emoji  = status === "delivered" ? "\u2705" : status === "active" ? "\u25B6\uFE0F" : "\u23F3";
    lines.push((i + 1) + ". " + emoji + " " + date + " — " + item + " — Rs." + o.totalAmount);
  });
  lines.push("\nLoyalty Coins: " + coins);
  lines.push("\n1. Reorder\n2. Subscription manage\n3. Back to menu");
  return lines.join("\n");
};

// ── Build welcome message ──────────────────────────────────────────────────────
const buildWelcome = (profile) => {
  const isRet = (profile.totalOrders || 0) > 0;
  const fname = profile.name ? profile.name.split(" ")[0] : null;
  const gname = fname ? fname + " ji" : null;
  const greet = "Namaste" + (gname ? ", " + gname : "") + "!";

  if (isRet) {
    return greet + " Wapas aaye — swagat hai \uD83C\uDF3F\n\n" +
      (profile.lastOrderItems ? "Last order: " + profile.lastOrderItems + ". Dobara order karein?\n\n" : "") +
      "Kya karna hai:\n\n" +
      "1. Same order repeat karein\n" +
      "2. Aaj ka menu dekhein\n" +
      "3. Daily tiffin order (Rs.80/plate)\n" +
      "4. Monthly plan details\n" +
      "5. Mere orders aur account\n" +
      "6. Subscription manage karein\n" +
      "7. Offers aur coins\n" +
      "8. Owner se baat karein\n\n" +
      "Number bhejein ya seedha poochiye \uD83C\uDF3F";
  }
  return greet + " SatvikMeals mein swagat hai \uD83C\uDF3F\n\n" +
    "Patna ka trusted pure vegetarian meal service.\nGhar jaisa khana, fresh daily delivery.\n\n" +
    "Kya karna hai:\n\n" +
    "1. Aaj ka menu dekhein\n" +
    "2. Daily tiffin order (Rs.80/plate)\n" +
    "3. Monthly plan lein\n" +
    "4. Delivery check karein\n" +
    "5. Mere orders aur account\n" +
    "6. Subscription manage karein\n" +
    "7. Offers aur coins\n" +
    "8. Owner se baat karein\n\n" +
    "Number bhejein ya seedha poochiye \uD83C\uDF3F";
};

// ── Confused user fallback ─────────────────────────────────────────────────────
const CONFUSED_REPLY =
  "Samajh nahi aaya, maafi chahta hoon \uD83C\uDF3F\n\n" +
  "Yeh try karein:\n\n" +
  "1. Aaj ka menu\n" +
  "2. Order karein\n" +
  "3. Monthly plans\n" +
  "4. Mere orders\n" +
  "5. Help\n\n" +
  "Ya seedha call karein: 6201276506";

// ── Instant reply map ──────────────────────────────────────────────────────────
const buildInstantMap = (profile) => {
  const fname = profile.name ? profile.name.split(" ")[0] : null;
  const gn    = fname ? fname + " ji" : null;
  const me    = "Main SatvikMeals ka virtual representative Satvik hoon \uD83C\uDF3F Kya madad kar sakta hoon?";
  const wait  = (gn ? gn + ", a" : "A") + "apke sawaal par kaam kar raha hoon \uD83C\uDF3F Ek moment...";
  const yes   = (gn ? "Ji " + gn + "! " : "Ji! ") + "Kya kar sakta hoon?";

  return {
    "tum kaun ho": me, "tum koun ho": me, "tum kon ho": me, "aap kaun ho": me,
    "aap kaun hain": me, "aap kon ho": me, "who are you": me,
    "bot ho kya": me, "ai ho": me, "robot ho": me,
    "kya hua": wait, "kya hoa": wait, "kya ho gaya": wait, "kuch bolo": (gn ? "Haan " + gn + ", kya chahiye?" : "Haan boliye \uD83C\uDF3F"),
    "bolo": (gn ? "Haan " + gn + ", kya chahiye?" : "Haan boliye \uD83C\uDF3F"),
    "btao": (gn ? "Haan " + gn + ", boliye." : "Haan boliye \uD83C\uDF3F"),
    "batao": (gn ? "Haan " + gn + ", boliye." : "Haan boliye \uD83C\uDF3F"),
    "bataiye": (gn ? "Haan " + gn + ", boliye." : "Haan boliye \uD83C\uDF3F"),
    "ok": yes, "okay": yes, "ji": yes, "haan": yes, "ha": yes,
    "theek hai": yes, "thik hai": yes, "acha": yes, "accha": yes,
    "thanks": "Shukriya \uD83C\uDF3F Aur koi madad ho to batayein.",
    "thank you": "Shukriya \uD83C\uDF3F",
    "shukriya": "Aapka bhi shukriya \uD83C\uDF3F",
    "dhanyavaad": "Aapka swagat hai \uD83C\uDF3F",
    "bye": (gn ? "Khuda hafiz, " + gn + " \uD83C\uDF3F Kisi madad mein wapas aayein." : "Khuda hafiz \uD83C\uDF3F"),
    "goodbye": (gn ? "Khuda hafiz, " + gn + " \uD83C\uDF3F" : "Khuda hafiz \uD83C\uDF3F"),
    "7": "SatvikMeals ke current offers \uD83C\uDF3F\n\n1. Loyalty Coins: Har order pe earn karein — 1 coin = Rs.1 off (max 50%)\n2. Referral: Dost ko refer karein, 100 coins milenge aapko bhi\n3. Monthly plan: Free delivery + best value per meal\n\nCoins balance ke liye option 5 bhejein",
    "8": null, // handled by AI (transfer to owner)
  };
};

const GREET_REGEX = /^(hi+|hello+|hey+|namaste|helo|start|menu|help|hii+|salam|assalam)[\s!?.]*$/i;
const ORDERS_REGEX = /\b(order|orders|mera order|mere orders|see order|check order|order history|order dekhein|order dikhaiye|order dikhao|order status)\b/i;
const LOGO_REGEX = /\.(jpg|jpeg|png|webp|gif)(\?|$)/i;

// ── Main handler ───────────────────────────────────────────────────────────────
const handleMessage = async (sock, rawJid, userText, pushName = "") => {
  const phoneNumber = ctx.normalizePhone(rawJid);
  console.log("[IN]  " + phoneNumber + ": " + userText.slice(0, 80));

  if (admin.isBlocked(phoneNumber)) { console.log("[BLOCKED] " + phoneNumber); return; }

  if (ctx.isAlreadyProcessing(phoneNumber)) {
    ctx.enqueue(phoneNumber, { sock, rawJid, userText, pushName });
    console.log("[QUEUED] " + phoneNumber + ": " + userText.slice(0, 40));
    return;
  }
  ctx.markProcessingStart(phoneNumber);

  try {
    const { history, profile, isNewUser } = await ctx.getHistoryAndProfile(phoneNumber);

    if (!profile.phone) { await ctx.updateProfile(phoneNumber, { phone: phoneNumber }); profile.phone = phoneNumber; }
    if (pushName && !profile.name) { await ctx.savePushNameIfNew(phoneNumber, pushName); profile.name = pushName; }

    // ── Transferred to owner — forward to admin ───────────────────────────────
    if (profile.isTransferred) {
      await ctx.appendExchange(phoneNumber, userText, "");
      await admin.toDM("\uD83D\uDCAC MSG FROM TRANSFERRED CUSTOMER\n\n\uD83D\uDC64 " + (profile.name || "Unknown") + " \u2014 " + phoneNumber + "\n\n" + userText);
      return;
    }

    // ── Greeting \u2014 instant welcome, no AI ──────────────────────────────────────
    if (GREET_REGEX.test(userText.trim())) {
      const logoUrl = process.env.LOGO_URL || "";
      if (logoUrl && LOGO_REGEX.test(logoUrl)) {
        try { await sock.sendMessage(rawJid, { image: { url: logoUrl }, caption: "" }); }
        catch (e) { console.warn("[LOGO]", e.message); }
      }
      const welcome = buildWelcome(profile);
      await ctx.appendExchange(phoneNumber, userText, welcome);
      await ctx.updateProfile(phoneNumber, { firstMessageSent: true });
      await sock.sendMessage(rawJid, { text: welcome });
      console.log("[WELCOME] " + phoneNumber);
      return;
    }

    // ── Orders request \u2014 fetch and show directly ───────────────────────────────
    if (ORDERS_REGEX.test(userText) || userText.trim() === "5") {
      try { await sock.sendPresenceUpdate("composing", rawJid); } catch (_) {}
      const accountData = await fetchAccountData(phoneNumber);
      try { await sock.sendPresenceUpdate("available", rawJid); } catch (_) {}
      const reply = formatOrdersReply(accountData || { orders: [], totalOrders: 0, coins: 0 }, profile);
      await ctx.appendExchange(phoneNumber, userText, reply);
      await sock.sendMessage(rawJid, { text: reply });
      console.log("[ORDERS] " + phoneNumber);
      return;
    }

    // ── Instant replies \u2014 no AI ────────────────────────────────────────────────
    const t = userText.trim().toLowerCase().replace(/[?!.,;]+$/, "").trim();
    const instantMap = buildInstantMap(profile);
    if (Object.prototype.hasOwnProperty.call(instantMap, t) && instantMap[t] !== null) {
      const reply = instantMap[t];
      await ctx.appendExchange(phoneNumber, userText, reply);
      await sock.sendMessage(rawJid, { text: reply });
      console.log("[INSTANT] " + phoneNumber + ": " + t);
      return;
    }

    // ── AI call ───────────────────────────────────────────────────────────────
    try { await sock.sendPresenceUpdate("composing", rawJid); } catch (_) {}

    let aiReply;
    try {
      aiReply = await chat(userText, history, profile, null, isNewUser);
      console.log("[AI]  " + phoneNumber + ": " + aiReply.slice(0, 100));
    } catch (aiErr) {
      console.error("[AI ERR] " + phoneNumber + ": " + aiErr.message);
      // Send confused fallback — don't crash the whole handler
      try { await sock.sendPresenceUpdate("available", rawJid); } catch (_) {}
      await sock.sendMessage(rawJid, { text: CONFUSED_REPLY });
      await ctx.appendExchange(phoneNumber, userText, CONFUSED_REPLY);
      return;
    }

    if (hasBlock(aiReply, "FETCH_ACCOUNT")) {
      const accountData = await fetchAccountData(phoneNumber);
      try { aiReply = await chat(userText, history, profile, accountData, isNewUser); }
      catch (_) {} // use original reply if retry fails
    }

    try { await sock.sendPresenceUpdate("available", rawJid); } catch (_) {}
    const cleanedReply = cleanReply(aiReply);
    await ctx.appendExchange(phoneNumber, userText, cleanedReply);

    // ── Action blocks ──────────────────────────────────────────────────────────
    const regBlock = extractBlock(aiReply, "REGISTER_USER");
    if (regBlock) {
      const name = regBlock.get("Name") || profile.name || "Customer";
      const phone = regBlock.get("Phone") || profile.phone || phoneNumber;
      const email = regBlock.get("Email") || profile.email || "";
      try {
        const result = await api.findOrCreateUser({ name, phone, email, source: "whatsapp_bot" });
        const uid = result?.user?._id || result?._id;
        if (uid) { try { await api.updateUser(uid, { name, phone, email }); } catch (_) {} await ctx.updateProfile(phoneNumber, { name, phone, email, linkedUserId: String(uid) }); }
        else await ctx.updateProfile(phoneNumber, { name, phone, email });
      } catch (e) { console.warn("[REGISTER]", e.message); await ctx.updateProfile(phoneNumber, { name, email }); }
      await admin.notifyNewUser({ phoneNumber, name, phone });
    }

    const updProfileBlock = extractBlock(aiReply, "UPDATE_PROFILE");
    if (updProfileBlock) {
      const u = {};
      const n = updProfileBlock.get("Name"), e = updProfileBlock.get("Email"), a = updProfileBlock.get("Address");
      if (n) u.name = n; if (e) u.email = e; if (a) u.address = a;
      if (Object.keys(u).length) { await ctx.updateProfile(phoneNumber, u); if (profile.linkedUserId) try { await api.updateUser(profile.linkedUserId, u); } catch (_) {} }
    }

    const subBlock = extractBlock(aiReply, "SUBSCRIPTION_INTEREST");
    if (subBlock) {
      const planName = subBlock.get("Plan"), customerName = subBlock.get("Name") || profile.name || "", address = subBlock.get("Address") || profile.address || "";
      try { await api.createSubscriptionLead({ phoneNumber, customerName, planName, address, source: "whatsapp_bot" }); } catch (_) {}
      await ctx.updateProfile(phoneNumber, { name: customerName || undefined, address: address || undefined, lastPlanSeen: planName });
      await admin.notifySubscriptionInterest({ phoneNumber, planName, customerName, address });
    }

    const payBlock = extractBlock(aiReply, "CONFIRM_PAYMENT");
    if (payBlock) {
      const amount = payBlock.get("Amount"), ref = payBlock.get("Reference") || "";
      try { await api.confirmPayment({ phoneNumber, name: profile.name, amount, reference: ref, source: "whatsapp_bot" }); } catch (_) {}
      await admin.toEventsGroup("\uD83D\uDCB0 PAYMENT CONFIRMED\n\n\uD83D\uDC64 " + (profile.name || "Unknown") + "\n\uD83D\uDCF1 " + phoneNumber + "\nRs." + amount + " | Ref: " + (ref || "Not given"));
    }

    const dailyBlock = extractBlock(aiReply, "DAILY_ORDER");
    if (dailyBlock) {
      const plates = dailyBlock.get("Plates"), meals = dailyBlock.get("Meals"), days = dailyBlock.get("Days");
      const address = dailyBlock.get("Address") || profile.address || "", amount = dailyBlock.get("Amount");
      try { await api.createOrder({ phoneNumber, customerName: profile.name || "Customer", address, orderType: "daily_tiffin", items: [{ name: "Daily Tiffin (" + meals + ")", quantity: parseInt(plates)||1, price: 80 }], totalAmount: parseInt(amount)||80, days, source: "whatsapp_bot" }); } catch (e) { console.warn("[DAILY_ORDER]", e.message); }
      await ctx.recordOrder(phoneNumber, "Daily x" + plates + " (" + meals + ") for " + days);
      await admin.notifyNewOrder({ phoneNumber, customerName: profile.name || "Customer", address, item: "Daily Tiffin x" + plates + " (" + meals + ") for " + days, amount: parseInt(amount)||80 });
    }

    const customBlock = extractBlock(aiReply, "CUSTOM_ORDER");
    if (customBlock) {
      const request = customBlock.get("Request") || customBlock.raw;
      await admin.toEventsGroup("\uD83C\uDF7D CUSTOM ORDER\n\n\uD83D\uDC64 " + (profile.name||"Unknown") + "\n\uD83D\uDCF1 " + phoneNumber + "\n\n" + request);
      await admin.toDM("\uD83C\uDF7D CUSTOM ORDER — ACTION NEEDED\n\n\uD83D\uDC64 " + (profile.name||"Unknown") + " \u2014 " + phoneNumber + "\n\n" + request + "\n\nReply: !send " + phoneNumber + " your message");
    }

    const delivApproved = extractBlock(aiReply, "DELIVERY_APPROVED");
    if (delivApproved) { const area = delivApproved.get("Area"); await ctx.updateProfile(phoneNumber, { deliveryZone: "approved" }); console.log("[DELIVERY] Approved: " + area); }

    const delivCheck = extractBlock(aiReply, "DELIVERY_CHECK_NEEDED");
    if (delivCheck) {
      const area = delivCheck.get("Area");
      await ctx.updateProfile(phoneNumber, { deliveryZone: "pending_approval" });
      await admin.toDM("\uD83D\uDCCD DELIVERY APPROVAL NEEDED\n\n\uD83D\uDC64 " + (profile.name||"Unknown") + " \u2014 " + phoneNumber + "\nArea: " + area + "\n\nApprove: !send " + phoneNumber + " Aapke area mein delivery available hai \u2705\nDecline: !send " + phoneNumber + " Aapke area mein abhi delivery available nahi hai.");
    }

    const transferBlock = extractBlock(aiReply, "TRANSFER_TO_OWNER");
    if (transferBlock) {
      const reason = transferBlock.get("Reason") || "Requested";
      await ctx.updateProfile(phoneNumber, { isTransferred: true });
      await admin.toDM("\uD83D\uDD34 CUSTOMER WANTS TO TALK\n\n\uD83D\uDC64 " + (profile.name||"Unknown") + " \u2014 " + phoneNumber + "\nReason: " + reason + "\n\nReply: !send " + phoneNumber + " Namaste!\nWhen done: !unfreeze " + phoneNumber);
      await admin.toEventsGroup("\uD83D\uDD34 TRANSFER TO OWNER\n\n\uD83D\uDC64 " + (profile.name||"Unknown") + " \u2014 " + phoneNumber);
    }

    const feedbackBlock = extractBlock(aiReply, "FEEDBACK");
    if (feedbackBlock) {
      await ctx.updateProfile(phoneNumber, { lastFeedbackAt: new Date() });
      await admin.toEventsGroup("\u2B50 FEEDBACK\n\n\uD83D\uDC64 " + (profile.name||"Unknown") + " \u2014 " + phoneNumber + "\nRating: " + (feedbackBlock.get("Rating")||"N/A") + "/5\n" + feedbackBlock.get("Comment"));
    }

    const changePlanBlock = extractBlock(aiReply, "CHANGE_PLAN");
    if (changePlanBlock) { const p = changePlanBlock.get("Plan"); try { await api.changePlan({ phoneNumber, planName: p, name: profile.name }); } catch (_) {} await ctx.updateProfile(phoneNumber, { lastPlanSeen: p }); await admin.toEventsGroup("\uD83D\uDD04 PLAN CHANGE\n\n\uD83D\uDC64 " + (profile.name||"Unknown") + " \u2014 " + phoneNumber + "\nNew: " + p); }

    const addrBlock = extractBlock(aiReply, "UPDATE_ADDRESS");
    if (addrBlock) { const a = addrBlock.get("Address"); if (a) { await ctx.updateProfile(phoneNumber, { address: a }); try { await api.updateDeliveryAddress({ phoneNumber, address: a, name: profile.name }); } catch (_) {} } }

    const prefBlock = extractBlock(aiReply, "UPDATE_MEAL_PREF");
    if (prefBlock) { const p = prefBlock.get("Preference"); await ctx.updateProfile(phoneNumber, { mealPreference: p }); try { await api.updateMealPreference({ phoneNumber, preference: p, name: profile.name }); } catch (_) {} await admin.toEventsGroup("\uD83C\uDF7D MEAL PREF\n\n" + (profile.name||"Unknown") + " \u2014 " + phoneNumber + "\n" + p); }

    const pauseBlock = extractBlock(aiReply, "PAUSE_SUBSCRIPTION");
    if (pauseBlock) { const u = pauseBlock.get("Until"); try { await api.pauseSubscription({ phoneNumber, name: profile.name, pauseUntil: u }); } catch (_) {} await admin.toEventsGroup("\u23F8 PAUSED\n\n" + (profile.name||"Unknown") + " \u2014 " + phoneNumber + (u ? "\nUntil: " + u : "")); }

    const resumeBlock = extractBlock(aiReply, "RESUME_SUBSCRIPTION");
    if (resumeBlock) { try { await api.resumeSubscription({ phoneNumber, name: profile.name }); } catch (_) {} await admin.toEventsGroup("\u25B6\uFE0F RESUMED\n\n" + (profile.name||"Unknown") + " \u2014 " + phoneNumber); }

    const cancelBlock = extractBlock(aiReply, "CANCEL_SUBSCRIPTION");
    if (cancelBlock) { const r = cancelBlock.get("Reason")||"Not given"; try { await api.cancelSubscription({ phoneNumber, name: profile.name, reason: r }); } catch (_) {} await admin.toEventsGroup("\u274C CANCELLED\n\n" + (profile.name||"Unknown") + " \u2014 " + phoneNumber + "\nReason: " + r); }

    const coinsBlock = extractBlock(aiReply, "APPLY_COINS");
    if (coinsBlock) { try { await api.applyCoins({ phoneNumber, coins: coinsBlock.get("Coins"), name: profile.name }); } catch (_) {} }

    const compBlock = extractBlock(aiReply, "COMPLAINT");
    if (compBlock) {
      const type = compBlock.get("Type")||"complaint", issue = compBlock.get("Issue")||compBlock.raw;
      try { await api.submitComplaint({ phoneNumber, name: profile.name||"Unknown", type, issue, source: "whatsapp_bot" }); } catch (_) {}
      await admin.notifyComplaint({ phoneNumber, type, issue });
    }

    const healthBlock = extractBlock(aiReply, "HEALTH_NOTE");
    if (healthBlock) {
      const note = healthBlock.get("Note")||healthBlock.raw;
      await ctx.updateProfile(phoneNumber, { healthNotes: note });
      try { await api.updateMealPreference({ phoneNumber, healthNote: note, name: profile.name }); } catch (_) {}
      await admin.notifyHealthNote({ phoneNumber, note });
    }

    const callbackBlock = extractBlock(aiReply, "REQUEST_CALLBACK");
    if (callbackBlock) {
      const reason = callbackBlock.get("Reason")||"Not given", time = callbackBlock.get("Time")||"Any time";
      try { await api.requestCallback({ phoneNumber, name: profile.name, reason, preferredTime: time }); } catch (_) {}
      await admin.toDM("\uD83D\uDCDE CALLBACK\n\n" + (profile.name||"Unknown") + " \u2014 " + phoneNumber + "\nReason: " + reason + "\nTime: " + time + "\n\nReply: !send " + phoneNumber + " your message");
    }

    const orderBlock = extractBlock(aiReply, "ORDER_CONFIRMED");
    if (orderBlock) {
      const customerName = orderBlock.get("Name")||profile.name||"Unknown";
      const address = orderBlock.get("Address")||profile.address||"";
      const item    = orderBlock.get("Item")||"Tiffin";
      const amount  = parseInt((orderBlock.get("Amount")||"0").replace(/[^\d]/g,""))||0;
      try { await api.createOrder({ phoneNumber, customerName, address, items:[{name:item,quantity:1,price:amount}], totalAmount:amount, source:"whatsapp_bot" }); } catch (_) {}
      await ctx.updateProfile(phoneNumber, { name: customerName, address });
      await ctx.recordOrder(phoneNumber, item);
      await admin.notifyNewOrder({ phoneNumber, customerName, address, item, amount });
      await ctx.trimHistoryAfterOrder(phoneNumber);
    }

    // ── Send reply (with retry on connection error) ───────────────────────────
    if (cleanedReply) {
      let sent = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await sock.sendMessage(rawJid, { text: cleanedReply });
          console.log("[OUT] " + phoneNumber + ": " + cleanedReply.slice(0, 80));
          sent = true;
          break;
        } catch (sendErr) {
          console.warn("[SEND RETRY " + (attempt+1) + "] " + phoneNumber + ": " + sendErr.message);
          if (attempt < 2) await new Promise(r => setTimeout(r, 2000));
        }
      }
      if (!sent) console.error("[SEND FAILED] " + phoneNumber + " — message lost after 3 attempts");
    }

  } catch (err) {
    console.error("[ERR] " + phoneNumber + ": " + err.message);
    try { await sock.sendPresenceUpdate("available", rawJid); } catch (_) {}
    try { await sock.sendMessage(rawJid, { text: "Kuch technical issue aa gaya hai \uD83D\uDE4F Thodi der mein try karein ya call karein: 6201276506" }); } catch (_) {}
  } finally {
    ctx.markProcessingDone(phoneNumber);
    if (ctx.hasQueued(phoneNumber)) {
      const next = ctx.dequeue(phoneNumber);
      if (next) setImmediate(() => handleMessage(next.sock, next.rawJid, next.userText, next.pushName).catch(e => console.error("[QUEUE_ERR]", e.message)));
    }
  }
};

module.exports = { handleMessage };
