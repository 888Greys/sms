import type { Handler } from "@netlify/functions";
import type { Redis } from "@upstash/redis";
import { getConfig } from "./_lib/config.js";
import { createKeys, parseBatchFromNumberId } from "./_lib/keys.js";
import { getRedis } from "./_lib/redis.js";
import {
  answerCallbackQuery,
  sendMessage,
  type InlineKeyboardMarkup,
  type TelegramCallbackQuery,
  type TelegramMessage,
  type TelegramUpdate
} from "./_lib/telegram.js";

const MIN_BATCH = 1;
const MAX_BATCH = 10;

interface ProgressSnapshot {
  total: number;
  sent: number;
  skipped: number;
  pendingQueue: number;
  remaining: number;
}

interface HistoryEntry {
  action: "sent" | "skipped";
  numberId: string;
  batch: number;
}

const config = getConfig();
const redis = getRedis();
const keys = createKeys(config.redisPrefix);

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const asInt = (value: unknown): number => {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
};

const buildBatchKeyboard = (): InlineKeyboardMarkup => {
  const rows: InlineKeyboardMarkup["inline_keyboard"] = [];
  for (let batch = MIN_BATCH; batch <= MAX_BATCH; batch += 1) {
    if ((batch - 1) % 5 === 0) {
      rows.push([]);
    }
    rows[rows.length - 1]?.push({
      text: `Batch ${batch}`,
      callback_data: `batch:${batch}`
    });
  }
  return { inline_keyboard: rows };
};

const buildActionKeyboard = (numberId: string): InlineKeyboardMarkup => ({
  inline_keyboard: [
    [
      { text: "Sent ✅", callback_data: `sent:${numberId}` },
      { text: "Skip ⏭", callback_data: `skip:${numberId}` }
    ],
    [
      { text: "Undo ↩", callback_data: "undo" },
      { text: "Next ▶", callback_data: "next" }
    ],
    [{ text: "Progress 📊", callback_data: "progress" }]
  ]
});

const getSelectedBatch = async (userId: number): Promise<number | null> => {
  const raw = await redis.get<string | number | null>(keys.agentBatch(userId));
  if (raw === null) {
    return null;
  }
  const value = asInt(raw);
  return value >= MIN_BATCH && value <= MAX_BATCH ? value : null;
};

const setSelectedBatch = async (userId: number, batch: number): Promise<void> => {
  await redis.set(keys.agentBatch(userId), batch);
};

const getCurrentNumberId = async (userId: number): Promise<string | null> => {
  const value = await redis.get<string | null>(keys.agentCurrent(userId));
  return value && value.length > 0 ? value : null;
};

const getPhoneForNumberId = async (numberId: string): Promise<string | null> => {
  const record = await redis.hgetall<Record<string, string> | null>(keys.number(numberId));
  if (!record) {
    return null;
  }
  return record.phone ?? null;
};

const getProgress = async (batch: number): Promise<ProgressSnapshot> => {
  const [totalRaw, sentRaw, skippedRaw, pendingQueueRaw] = await Promise.all([
    redis.get<string | number | null>(keys.batchTotal(batch)),
    redis.scard(keys.batchSent(batch)),
    redis.scard(keys.batchSkipped(batch)),
    redis.llen(keys.batchPending(batch))
  ]);

  const total = asInt(totalRaw);
  const sent = asInt(sentRaw);
  const skipped = asInt(skippedRaw);
  const pendingQueue = asInt(pendingQueueRaw);
  const remaining = Math.max(total - sent - skipped, 0);

  return { total, sent, skipped, pendingQueue, remaining };
};

const pushHistory = async (userId: number, entry: HistoryEntry): Promise<void> => {
  await redis.lpush(keys.agentHistory(userId), JSON.stringify(entry));
  await redis.ltrim(keys.agentHistory(userId), 0, 49);
};

const popHistory = async (userId: number): Promise<HistoryEntry | null> => {
  const raw = await redis.lpop<string | null>(keys.agentHistory(userId));
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<HistoryEntry>;
    if (
      (parsed.action === "sent" || parsed.action === "skipped") &&
      typeof parsed.numberId === "string" &&
      typeof parsed.batch === "number"
    ) {
      return {
        action: parsed.action,
        numberId: parsed.numberId,
        batch: parsed.batch
      };
    }
  } catch {
    return null;
  }
  return null;
};

const assignOrReuseCurrent = async (userId: number, batch: number): Promise<string | null> => {
  const existing = await getCurrentNumberId(userId);
  if (existing) {
    return existing;
  }

  const nextNumberId = await redis.lpop<string | null>(keys.batchPending(batch));
  if (!nextNumberId) {
    return null;
  }

  await redis.set(keys.agentCurrent(userId), nextNumberId);
  await redis.hset(keys.number(nextNumberId), {
    status: "assigned",
    assignedTo: String(userId),
    assignedAt: new Date().toISOString()
  });
  return nextNumberId;
};

const sendBatchPicker = async (chatId: number): Promise<void> => {
  await sendMessage(
    config.botToken,
    chatId,
    "<b>Select a batch to start</b>\nTap one batch below.",
    buildBatchKeyboard()
  );
};

const sendProgress = async (chatId: number, userId: number): Promise<void> => {
  const batch = await getSelectedBatch(userId);
  if (!batch) {
    await sendMessage(
      config.botToken,
      chatId,
      "No batch selected yet. Use /start or /batch first."
    );
    return;
  }

  const progress = await getProgress(batch);
  await sendMessage(
    config.botToken,
    chatId,
    `<b>Batch ${batch} Progress</b>\n` +
      `Total: <b>${progress.total}</b>\n` +
      `Sent: <b>${progress.sent}</b>\n` +
      `Skipped: <b>${progress.skipped}</b>\n` +
      `Queue pending: <b>${progress.pendingQueue}</b>\n` +
      `Remaining overall: <b>${progress.remaining}</b>`
  );
};

const sendCurrentOrNext = async (chatId: number, userId: number): Promise<void> => {
  const batch = await getSelectedBatch(userId);
  if (!batch) {
    await sendBatchPicker(chatId);
    return;
  }

  const numberId = await assignOrReuseCurrent(userId, batch);
  if (!numberId) {
    const progress = await getProgress(batch);
    await sendMessage(
      config.botToken,
      chatId,
      `<b>Batch ${batch} complete for now.</b>\n` +
        `Sent: <b>${progress.sent}</b>, Skipped: <b>${progress.skipped}</b>, Remaining: <b>${progress.remaining}</b>`
    );
    return;
  }

  const phone = await getPhoneForNumberId(numberId);
  if (!phone) {
    await redis.del(keys.agentCurrent(userId));
    await sendMessage(
      config.botToken,
      chatId,
      "Could not load this number. Tap Next again."
    );
    return;
  }

  const progress = await getProgress(batch);
  await sendMessage(
    config.botToken,
    chatId,
    `<b>Batch ${batch}</b>\n` +
      `Copy number:\n<code>${escapeHtml(phone)}</code>\n\n` +
      `Sent ${progress.sent} | Skipped ${progress.skipped} | Remaining ${progress.remaining}`,
    buildActionKeyboard(numberId)
  );
};

const markCurrent = async (
  userId: number,
  action: "sent" | "skipped",
  numberIdFromButton: string
): Promise<"ok" | "stale" | "invalid"> => {
  const current = await getCurrentNumberId(userId);
  if (!current || current !== numberIdFromButton) {
    return "stale";
  }

  const batch = parseBatchFromNumberId(current);
  if (!batch) {
    return "invalid";
  }

  const now = new Date().toISOString();
  await redis.hset(keys.number(current), {
    status: action,
    updatedAt: now,
    ...(action === "sent" ? { sentAt: now } : { skippedAt: now })
  });

  if (action === "sent") {
    await redis.sadd(keys.batchSent(batch), current);
  } else {
    await redis.sadd(keys.batchSkipped(batch), current);
  }

  await pushHistory(userId, {
    action,
    numberId: current,
    batch
  });
  await redis.del(keys.agentCurrent(userId));
  return "ok";
};

const undoLast = async (chatId: number, userId: number): Promise<void> => {
  const entry = await popHistory(userId);
  if (!entry) {
    await sendMessage(config.botToken, chatId, "Nothing to undo.");
    return;
  }

  await redis.hset(keys.number(entry.numberId), {
    status: "pending",
    updatedAt: new Date().toISOString()
  });
  await redis.hdel(keys.number(entry.numberId), "sentAt", "skippedAt");

  if (entry.action === "sent") {
    await redis.srem(keys.batchSent(entry.batch), entry.numberId);
  } else {
    await redis.srem(keys.batchSkipped(entry.batch), entry.numberId);
  }

  await redis.lpush(keys.batchPending(entry.batch), entry.numberId);
  await redis.set(keys.agentCurrent(userId), entry.numberId);

  const phone = await getPhoneForNumberId(entry.numberId);
  if (!phone) {
    await sendMessage(config.botToken, chatId, "Undo applied, but number lookup failed.");
    return;
  }

  await sendMessage(
    config.botToken,
    chatId,
    `<b>Undo complete</b>\nRestored number:\n<code>${escapeHtml(phone)}</code>`,
    buildActionKeyboard(entry.numberId)
  );
};

const parseBatchArg = (text: string): number | null => {
  const match = /^\/batch(?:@\w+)?\s+(\d+)$/.exec(text.trim());
  if (!match) {
    return null;
  }
  const batch = Number.parseInt(match[1], 10);
  if (batch < MIN_BATCH || batch > MAX_BATCH) {
    return null;
  }
  return batch;
};

const handleTextMessage = async (message: TelegramMessage): Promise<void> => {
  const userId = message.from?.id;
  const chatId = message.chat.id;
  const text = message.text?.trim() ?? "";

  if (!userId) {
    return;
  }

  if (text.startsWith("/start")) {
    await sendMessage(
      config.botToken,
      chatId,
      "<b>Manual SMS helper bot</b>\nCommands: /batch, /next, /progress, /undo"
    );
    await sendBatchPicker(chatId);
    return;
  }

  if (text.startsWith("/help")) {
    await sendMessage(
      config.botToken,
      chatId,
      "Commands:\n" +
        "/start - open batch chooser\n" +
        "/batch - choose batch via buttons\n" +
        "/batch <n> - choose specific batch\n" +
        "/next - get current or next number\n" +
        "/progress - show stats\n" +
        "/undo - revert last Sent/Skip"
    );
    return;
  }

  if (text.startsWith("/batch")) {
    const batchFromArg = parseBatchArg(text);
    if (batchFromArg) {
      await setSelectedBatch(userId, batchFromArg);
      await redis.del(keys.agentCurrent(userId));
      await sendMessage(config.botToken, chatId, `Batch ${batchFromArg} selected.`);
      await sendCurrentOrNext(chatId, userId);
      return;
    }
    await sendBatchPicker(chatId);
    return;
  }

  if (text.startsWith("/next")) {
    await sendCurrentOrNext(chatId, userId);
    return;
  }

  if (text.startsWith("/progress")) {
    await sendProgress(chatId, userId);
    return;
  }

  if (text.startsWith("/undo")) {
    await undoLast(chatId, userId);
    return;
  }

  await sendMessage(config.botToken, chatId, "Use /start to begin.");
};

const parseAction = (data: string): { kind: "sent" | "skip"; numberId: string } | null => {
  if (data.startsWith("sent:")) {
    return { kind: "sent", numberId: data.slice(5) };
  }
  if (data.startsWith("skip:")) {
    return { kind: "skip", numberId: data.slice(5) };
  }
  return null;
};

const handleCallback = async (callback: TelegramCallbackQuery): Promise<void> => {
  const data = callback.data ?? "";
  const userId = callback.from.id;
  const chatId = callback.message?.chat.id;

  if (!chatId) {
    await answerCallbackQuery(config.botToken, callback.id);
    return;
  }

  if (data.startsWith("batch:")) {
    const batch = Number.parseInt(data.slice(6), 10);
    await answerCallbackQuery(config.botToken, callback.id);
    if (Number.isNaN(batch) || batch < MIN_BATCH || batch > MAX_BATCH) {
      await sendMessage(config.botToken, chatId, "Invalid batch.");
      return;
    }
    await setSelectedBatch(userId, batch);
    await redis.del(keys.agentCurrent(userId));
    await sendMessage(config.botToken, chatId, `Batch ${batch} selected.`);
    await sendCurrentOrNext(chatId, userId);
    return;
  }

  const action = parseAction(data);
  if (action) {
    await answerCallbackQuery(config.botToken, callback.id);
    const result = await markCurrent(
      userId,
      action.kind === "sent" ? "sent" : "skipped",
      action.numberId
    );
    if (result === "stale") {
      await sendMessage(
        config.botToken,
        chatId,
        "That action is stale. Tap Next to continue."
      );
      return;
    }
    if (result === "invalid") {
      await sendMessage(config.botToken, chatId, "Could not process this number.");
      return;
    }
    await sendCurrentOrNext(chatId, userId);
    return;
  }

  if (data === "next") {
    await answerCallbackQuery(config.botToken, callback.id);
    await sendCurrentOrNext(chatId, userId);
    return;
  }

  if (data === "progress") {
    await answerCallbackQuery(config.botToken, callback.id);
    await sendProgress(chatId, userId);
    return;
  }

  if (data === "undo") {
    await answerCallbackQuery(config.botToken, callback.id);
    await undoLast(chatId, userId);
    return;
  }

  await answerCallbackQuery(config.botToken, callback.id, "Unknown action");
};

const readWebhookSecret = (headers: Record<string, string | undefined>): string | undefined => {
  return (
    headers["x-telegram-bot-api-secret-token"] ??
    headers["X-Telegram-Bot-Api-Secret-Token"]
  );
};

const processUpdate = async (update: TelegramUpdate): Promise<void> => {
  if (update.message) {
    await handleTextMessage(update.message);
    return;
  }
  if (update.callback_query) {
    await handleCallback(update.callback_query);
  }
};

export const handler: Handler = async (event) => {
  if (event.httpMethod === "GET") {
    return {
      statusCode: 200,
      body: "telegram webhook alive"
    };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: "Method Not Allowed"
    };
  }

  const providedSecret = readWebhookSecret(event.headers);
  if (!providedSecret || providedSecret !== config.webhookSecret) {
    return {
      statusCode: 401,
      body: "Unauthorized"
    };
  }

  if (!event.body) {
    return {
      statusCode: 400,
      body: "Missing body"
    };
  }

  try {
    const update = JSON.parse(event.body) as TelegramUpdate;
    await processUpdate(update);
  } catch (error) {
    console.error("Webhook processing failed", error);
  }

  return {
    statusCode: 200,
    body: "ok"
  };
};

// Avoid tree-shaking in some bundlers for static side effects.
void redis as Redis;
