const createUser = async ({ name, phone }) => {
  try {
    const email = `${phone}@whatsapp.satvikmeals.com`;
    const res = await fetch(`${process.env.WEBSITE_API_URL || "https://satvikmeals.com"}/api/auth/dev-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-bot-secret": process.env.BOT_SECRET || "" },
      body: JSON.stringify({ name, email }),
    });
    const data = await res.json();
    if (!res.ok) return { success: false, message: data.message };
    if (data.token && phone) {
      await fetch(`${process.env.WEBSITE_API_URL || "https://satvikmeals.in"}/api/auth/save-phone`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${data.token}` },
        body: JSON.stringify({ phone }),
      }).catch(() => {});
    }
    return { success: true, user: data.user };
  } catch (err) {
    return { success: false, message: err.message };
  }
};

module.exports = { createUser };
