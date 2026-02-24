import dotenv from "dotenv";

dotenv.config();

const requiredEnv = (name) => {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

const botToken = requiredEnv("BOT_TOKEN");
const webhookSecret = requiredEnv("TELEGRAM_WEBHOOK_SECRET");
const webhookBaseUrl = requiredEnv("WEBHOOK_BASE_URL").replace(/\/+$/, "");
const webhookUrl = `${webhookBaseUrl}/.netlify/functions/telegram-webhook`;

const response = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    url: webhookUrl,
    secret_token: webhookSecret,
    allowed_updates: ["message", "callback_query"]
  })
});

const responseBody = await response.text();
if (!response.ok) {
  throw new Error(`setWebhook failed: ${response.status} ${responseBody}`);
}

console.log(`Webhook set to: ${webhookUrl}`);
console.log(responseBody);
