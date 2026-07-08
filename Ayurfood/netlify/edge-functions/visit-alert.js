// Ayurfood/netlify/edge-functions/visit-alert.js
export default async (request, context) => {
  if (request.method !== "POST") return new Response(null, { status: 405 });

  const token  = Netlify.env.get("TELEGRAM_BOT_TOKEN");
  const chatId = Netlify.env.get("TELEGRAM_CHAT_ID");
  if (!token || !chatId) return new Response(null, { status: 204 });

  // Country only — from Netlify edge geo. No IP read, nothing stored.
  const country = context.geo?.country?.name || "Unknown";

  let page = "/";
  try {
    const body = await request.json();
    if (body && body.page) page = String(body.page).slice(0, 200);
  } catch (_) {}

  const text =
    "New visitor on ayurveda-food.com\n\n" +
    "Country: " + country + "\n" +
    "Page: " + page;

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text })
    });
  } catch (_) {} // alerting must never affect the visitor

  return new Response(null, { status: 204 });
};

export const config = { path: "/visit-alert" };
