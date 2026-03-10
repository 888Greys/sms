import "dotenv/config";
import { createServer } from "node:http";
import { getConfig } from "./lib/config.js";
import { createKeys, parseBatchFromNumberId } from "./lib/keys.js";
import { parseActionData, parseClaimArg, parseForceReleaseArg } from "./lib/parsers.js";
import { getRedis } from "./lib/redis.js";
import {
  answerCallbackQuery,
  deleteWebhook,
  getUpdates,
  sendMessage,
  type InlineKeyboardMarkup,
  type TelegramCallbackQuery,
  type TelegramMessage,
  type TelegramUpdate,
  type TelegramUser
} from "./lib/telegram.js";

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

interface BatchStatus {
  batch: number;
  ownerId: number | null;
  progress: ProgressSnapshot;
}

type ClaimResult =
  | "claimed"
  | "already_mine"
  | "has_other_batch"
  | "owned_by_other"
  | "empty";

const config = getConfig();
const redis = getRedis();
const keys = createKeys(config.redisPrefix);

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

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

const isAdmin = (userId: number): boolean => config.adminUserIds.has(userId);
const isAllowed = (userId: number): boolean => config.allowedUserIds.has(userId);

const getSelectedBatch = async (userId: number): Promise<number | null> => {
  const raw = await redis.get<string | number | null>(keys.agentBatch(userId));
  if (raw === null) {
    return null;
  }
  const value = asInt(raw);
  return value >= config.minBatch && value <= config.maxBatch ? value : null;
};

const getCurrentNumberId = async (userId: number): Promise<string | null> => {
  const value = await redis.get<string | null>(keys.agentCurrent(userId));
  return value && value.length > 0 ? value : null;
};

const getPhoneForNumberId = async (numberId: string): Promise<string | null> => {
  const record = await redis.hgetall<Record<string, string>>(keys.number(numberId));
  if (!record || typeof record.phone !== "string" || record.phone.length === 0) {
    return null;
  }
  return record.phone;
};

const getBatchOwnerId = async (batch: number): Promise<number | null> => {
  const ownerRaw = await redis.get<string | number | null>(keys.batchOwner(batch));
  if (ownerRaw === null) {
    return null;
  }
  const owner = asInt(ownerRaw);
  return owner > 0 ? owner : null;
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

const getBatchStatuses = async (): Promise<BatchStatus[]> => {
  const batches = [];
  for (let batch = config.minBatch; batch <= config.maxBatch; batch += 1) {
    batches.push(batch);
  }

  const statuses = await Promise.all(
    batches.map(async (batch): Promise<BatchStatus> => {
      const [ownerId, progress] = await Promise.all([
        getBatchOwnerId(batch),
        getProgress(batch)
      ]);
      return { batch, ownerId, progress };
    })
  );
  return statuses;
};

const buildActionKeyboard = (numberId: string): InlineKeyboardMarkup => ({
  inline_keyboard: [
    [
      { text: "Sent", callback_data: `sent:${numberId}` },
      { text: "Skip", callback_data: `skip:${numberId}` }
    ],
    [
      { text: "Undo", callback_data: "undo" },
      { text: "Next", callback_data: "next" }
    ],
    [
      { text: "Progress", callback_data: "progress" },
      { text: "My Batch", callback_data: "mybatch" },
      { text: "Release", callback_data: "release" }
    ]
  ]
});

const buildClaimKeyboard = (statuses: BatchStatus[], userId: number): InlineKeyboardMarkup => {
  const claimable = statuses.filter(
    (status) =>
      status.progress.remaining > 0 && (status.ownerId === null || status.ownerId === userId)
  );

  const rows: InlineKeyboardMarkup["inline_keyboard"] = [];
  for (const [idx, status] of claimable.entries()) {
    if (idx % 3 === 0) {
      rows.push([]);
    }
    rows[rows.length - 1]?.push({
      text: `Batch ${status.batch}`,
      callback_data: `claim:${status.batch}`
    });
  }
  return { inline_keyboard: rows };
};

const registerAgent = async (user: TelegramUser | undefined): Promise<void> => {
  if (!user) {
    return;
  }
  const now = new Date().toISOString();
  await redis.sadd(keys.agentsAll(), String(user.id));
  await redis.hset(keys.agentProfile(user.id), {
    firstName: user.first_name ?? "",
    lastName: user.last_name ?? "",
    username: user.username ?? "",
    lastSeenAt: now
  });
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

const claimBatch = async (userId: number, batch: number): Promise<ClaimResult> => {
  const currentBatch = await getSelectedBatch(userId);
  if (currentBatch !== null && currentBatch !== batch) {
    return "has_other_batch";
  }

  const [ownerId, progress] = await Promise.all([getBatchOwnerId(batch), getProgress(batch)]);
  if (progress.remaining <= 0) {
    return "empty";
  }
  if (ownerId === userId) {
    await redis.set(keys.agentBatch(userId), batch);
    return "already_mine";
  }
  if (ownerId !== null && ownerId !== userId) {
    return "owned_by_other";
  }

  const lockResult = await redis.set(keys.batchOwner(batch), String(userId), { nx: true });
  if (!lockResult) {
    const currentOwner = await getBatchOwnerId(batch);
    if (currentOwner === userId) {
      await redis.set(keys.agentBatch(userId), batch);
      return "already_mine";
    }
    return "owned_by_other";
  }

  await redis.set(keys.agentBatch(userId), batch);
  return "claimed";
};

const assignOrReuseCurrent = async (userId: number, batch: number): Promise<string | null> => {
  const existing = await getCurrentNumberId(userId);
  if (existing) {
    const existingBatch = parseBatchFromNumberId(existing);
    if (existingBatch === batch) {
      return existing;
    }
    await redis.del(keys.agentCurrent(userId));
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

const releaseBatchForUser = async (userId: number, batch: number): Promise<void> => {
  const currentNumberId = await getCurrentNumberId(userId);
  if (currentNumberId) {
    const currentBatch = parseBatchFromNumberId(currentNumberId);
    if (currentBatch === batch) {
      await redis.hset(keys.number(currentNumberId), {
        status: "pending",
        updatedAt: new Date().toISOString()
      });
      await redis.hdel(keys.number(currentNumberId), "assignedTo", "assignedAt");
      await redis.lpush(keys.batchPending(batch), currentNumberId);
    }
    await redis.del(keys.agentCurrent(userId));
  }

  const ownerId = await getBatchOwnerId(batch);
  if (ownerId === userId) {
    await redis.del(keys.batchOwner(batch));
  }
  await redis.del(keys.agentBatch(userId));
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
  const selectedBatch = await getSelectedBatch(userId);
  if (!batch || selectedBatch !== batch) {
    return "invalid";
  }

  const now = new Date().toISOString();
  await redis.hset(keys.number(current), {
    status: action,
    updatedAt: now,
    ...(action === "sent" ? { sentAt: now } : { skippedAt: now })
  });
  await redis.hdel(keys.number(current), "assignedTo", "assignedAt");

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

const sendProgressForBatch = async (chatId: number, batch: number): Promise<void> => {
  const progress = await getProgress(batch);
  await sendMessage(
    config.botToken,
    chatId,
    `<b>Batch ${batch} Progress</b>\n` +
    `Total: <b>${progress.total}</b>\n` +
    `Sent: <b>${progress.sent}</b>\n` +
    `Skipped: <b>${progress.skipped}</b>\n` +
    `Pending queue: <b>${progress.pendingQueue}</b>\n` +
    `Remaining overall: <b>${progress.remaining}</b>`
  );
};

const sendAssignedBatchProgress = async (chatId: number, userId: number): Promise<void> => {
  const batch = await getSelectedBatch(userId);
  if (!batch) {
    await sendMessage(config.botToken, chatId, "No batch assigned. Use /claim to take one.");
    return;
  }
  await sendProgressForBatch(chatId, batch);
};

const sendBatchStatus = async (chatId: number): Promise<void> => {
  const statuses = await getBatchStatuses();
  const lines = statuses.map((status) => {
    const ownerText = status.ownerId === null ? "free" : `owned by ${status.ownerId}`;
    return (
      `Batch ${status.batch}: ${ownerText}, ` +
      `remaining ${status.progress.remaining}, sent ${status.progress.sent}, skipped ${status.progress.skipped}`
    );
  });

  await sendMessage(
    config.botToken,
    chatId,
    `<b>Batch Status</b>\n${escapeHtml(lines.join("\n"))}`
  );
};

const sendClaimPicker = async (chatId: number, userId: number): Promise<void> => {
  const statuses = await getBatchStatuses();
  const claimKeyboard = buildClaimKeyboard(statuses, userId);
  if (claimKeyboard.inline_keyboard.length === 0) {
    await sendMessage(
      config.botToken,
      chatId,
      "No claimable batches right now. Use /status to check ownership and progress."
    );
    return;
  }

  await sendMessage(
    config.botToken,
    chatId,
    "<b>Choose a batch</b>\nOnly unowned batches with remaining numbers are shown.",
    claimKeyboard
  );
};

const sendAssignedBatch = async (chatId: number, userId: number): Promise<void> => {
  const batch = await getSelectedBatch(userId);
  if (!batch) {
    await sendMessage(config.botToken, chatId, "No batch assigned. Use /claim.");
    return;
  }
  const progress = await getProgress(batch);
  await sendMessage(
    config.botToken,
    chatId,
    `Assigned batch: <b>${batch}</b>\nRemaining: <b>${progress.remaining}</b>`
  );
};

const sendCurrentOrNext = async (chatId: number, userId: number): Promise<void> => {
  const batch = await getSelectedBatch(userId);
  if (!batch) {
    await sendMessage(config.botToken, chatId, "No batch assigned. Use /claim first.");
    return;
  }

  const ownerId = await getBatchOwnerId(batch);
  if (ownerId !== userId) {
    await redis.del(keys.agentBatch(userId));
    await sendMessage(
      config.botToken,
      chatId,
      "You no longer own this batch. Use /claim to select a new one."
    );
    return;
  }

  const numberId = await assignOrReuseCurrent(userId, batch);
  if (!numberId) {
    await sendMessage(
      config.botToken,
      chatId,
      `<b>Batch ${batch} is complete for now.</b>\nUse /status to review all batches.`
    );
    return;
  }

  const phone = await getPhoneForNumberId(numberId);
  if (!phone) {
    await redis.del(keys.agentCurrent(userId));
    await sendMessage(config.botToken, chatId, "Failed to load number, try /next again.");
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

const undoLast = async (chatId: number, userId: number): Promise<void> => {
  const entry = await popHistory(userId);
  if (!entry) {
    await sendMessage(config.botToken, chatId, "Nothing to undo.");
    return;
  }

  const ownerId = await getBatchOwnerId(entry.batch);
  if (ownerId !== userId) {
    await sendMessage(
      config.botToken,
      chatId,
      `Cannot undo because you do not own batch ${entry.batch}.`
    );
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
    await sendMessage(config.botToken, chatId, "Undo completed, but phone lookup failed.");
    return;
  }

  await sendMessage(
    config.botToken,
    chatId,
    `<b>Undo complete</b>\nRestored number:\n<code>${escapeHtml(phone)}</code>`,
    buildActionKeyboard(entry.numberId)
  );
};

const handleClaimRequest = async (chatId: number, userId: number, batch: number): Promise<void> => {
  const claimResult = await claimBatch(userId, batch);
  if (claimResult === "has_other_batch") {
    await sendMessage(
      config.botToken,
      chatId,
      "You already have a batch. Use /release before claiming another."
    );
    return;
  }
  if (claimResult === "owned_by_other") {
    await sendMessage(config.botToken, chatId, `Batch ${batch} is currently owned by another agent.`);
    return;
  }
  if (claimResult === "empty") {
    await sendMessage(config.botToken, chatId, `Batch ${batch} has no remaining numbers.`);
    return;
  }

  await sendMessage(
    config.botToken,
    chatId,
    claimResult === "claimed" ? `Batch ${batch} claimed.` : `Batch ${batch} is already yours.`
  );
  await sendCurrentOrNext(chatId, userId);
};

const handleReleaseRequest = async (chatId: number, userId: number): Promise<void> => {
  const batch = await getSelectedBatch(userId);
  if (!batch) {
    await sendMessage(config.botToken, chatId, "No assigned batch to release.");
    return;
  }

  await releaseBatchForUser(userId, batch);
  await sendMessage(
    config.botToken,
    chatId,
    `Released batch ${batch}. Use /claim to take another batch.`
  );
};

const handleForceRelease = async (
  chatId: number,
  requesterId: number,
  text: string
): Promise<void> => {
  if (!isAdmin(requesterId)) {
    await sendMessage(config.botToken, chatId, "Admin only command.");
    return;
  }

  const batch = parseForceReleaseArg(text, config.minBatch, config.maxBatch);
  if (!batch) {
    await sendMessage(config.botToken, chatId, "Usage: /force_release &lt;batch&gt;");
    return;
  }

  const ownerId = await getBatchOwnerId(batch);
  if (!ownerId) {
    await sendMessage(config.botToken, chatId, `Batch ${batch} is already unowned.`);
    return;
  }

  await releaseBatchForUser(ownerId, batch);
  await sendMessage(
    config.botToken,
    chatId,
    `Released batch ${batch} from agent ${ownerId}.`
  );
};

const handleResetAll = async (chatId: number, requesterId: number): Promise<void> => {
  if (!isAdmin(requesterId)) {
    await sendMessage(config.botToken, chatId, "Admin only command.");
    return;
  }

  const statuses = await getBatchStatuses();
  for (const { batch, ownerId } of statuses) {
    if (ownerId !== null) {
      await releaseBatchForUser(ownerId, batch);
    }
    // Clear sent/skipped sets and rebuild the pending queue from the number list
    const sentKey = keys.batchSent(batch);
    const skippedKey = keys.batchSkipped(batch);
    const pendingKey = keys.batchPending(batch);
    const numbersKey = keys.batchNumbers(batch);

    const allNumbers = await redis.lrange<string>(numbersKey, 0, -1);
    await redis.del(sentKey);
    await redis.del(skippedKey);
    await redis.del(pendingKey);
    if (allNumbers.length > 0) {
      await redis.rpush(pendingKey, ...allNumbers);
    }
  }

  await sendMessage(
    config.botToken,
    chatId,
    `<b>✅ All batches reset.</b>\nAll ownership cleared and pending queues rebuilt from scratch.`
  );
};

const handleAssignBatch = async (
  chatId: number,
  requesterId: number,
  text: string
): Promise<void> => {
  if (!isAdmin(requesterId)) {
    await sendMessage(config.botToken, chatId, "Admin only command.");
    return;
  }

  // Parse: /assign <batch> <user_id>
  const parts = text.trim().split(/\s+/);
  if (parts.length < 3) {
    await sendMessage(config.botToken, chatId, "Usage: /assign &lt;batch&gt; &lt;user_id&gt;");
    return;
  }
  const batch = Number.parseInt(parts[1] ?? "", 10);
  const targetUserId = Number.parseInt(parts[2] ?? "", 10);

  if (
    Number.isNaN(batch) || batch < config.minBatch || batch > config.maxBatch ||
    Number.isNaN(targetUserId) || targetUserId <= 0
  ) {
    await sendMessage(
      config.botToken,
      chatId,
      `Invalid arguments. Batch must be ${config.minBatch}–${config.maxBatch} and user_id must be a valid Telegram ID.`
    );
    return;
  }

  // Release current owner if any
  const currentOwner = await getBatchOwnerId(batch);
  if (currentOwner !== null && currentOwner !== targetUserId) {
    await releaseBatchForUser(currentOwner, batch);
  }

  // Assign to target
  await redis.set(keys.batchOwner(batch), String(targetUserId), { nx: true });
  await redis.set(keys.agentBatch(targetUserId), batch);

  const progress = await getProgress(batch);
  await sendMessage(
    config.botToken,
    chatId,
    `<b>✅ Batch ${batch} assigned to user ${targetUserId}.</b>\nRemaining: <b>${progress.remaining}</b>\n\nThey can now use /next to start working.`
  );
};

const handleTextMessage = async (message: TelegramMessage): Promise<void> => {
  const userId = message.from?.id;
  const chatId = message.chat.id;
  const text = message.text?.trim() ?? "";
  if (!userId) {
    return;
  }

  await registerAgent(message.from);

  if (!isAllowed(userId)) {
    await sendMessage(config.botToken, chatId, "⛔ You are not authorized to use this bot. Contact the admin to request access.");
    return;
  }

  if (text.startsWith("/start")) {
    await sendMessage(
      config.botToken,
      chatId,
      "<b>Manual SMS helper bot</b>\n" +
      "Commands:\n" +
      "/claim - choose a free batch\n" +
      "/claim &lt;n&gt; - claim batch n\n" +
      "/mybatch - show your assigned batch\n" +
      "/next - get current or next number\n" +
      "/progress - show your batch progress\n" +
      "/release - release your current batch\n" +
      "/undo - undo your last Sent/Skip\n" +
      "/status - show all batch status\n" +
      "\n<b>Admin only:</b>\n" +
      "/reset_all - reset ALL batches to fresh start\n" +
      "/assign &lt;batch&gt; &lt;user_id&gt; - assign batch to a user\n" +
      "/force_release &lt;n&gt; - force release a batch"
    );
    await sendClaimPicker(chatId, userId);
    return;
  }

  if (text.startsWith("/help")) {
    await sendMessage(
      config.botToken,
      chatId,
      "Commands:\n" +
      "/claim\n" +
      "/claim &lt;n&gt;\n" +
      "/mybatch\n" +
      "/next\n" +
      "/progress\n" +
      "/release\n" +
      "/undo\n" +
      "/status\n" +
      "/force_release &lt;n&gt; (admin)\n" +
      "/reset_all (admin)\n" +
      "/assign &lt;batch&gt; &lt;user_id&gt; (admin)"
    );
    return;
  }

  if (text.startsWith("/claim")) {
    const parsedBatch = parseClaimArg(text, config.minBatch, config.maxBatch);
    if (parsedBatch === null) {
      await sendClaimPicker(chatId, userId);
      return;
    }
    await handleClaimRequest(chatId, userId, parsedBatch);
    return;
  }

  if (text.startsWith("/mybatch")) {
    await sendAssignedBatch(chatId, userId);
    return;
  }

  if (text.startsWith("/next")) {
    await sendCurrentOrNext(chatId, userId);
    return;
  }

  if (text.startsWith("/progress")) {
    await sendAssignedBatchProgress(chatId, userId);
    return;
  }

  if (text.startsWith("/status")) {
    await sendBatchStatus(chatId);
    return;
  }

  if (text.startsWith("/undo")) {
    await undoLast(chatId, userId);
    return;
  }

  if (text.startsWith("/release")) {
    await handleReleaseRequest(chatId, userId);
    return;
  }

  if (text.startsWith("/force_release")) {
    await handleForceRelease(chatId, userId, text);
    return;
  }

  if (text.startsWith("/reset_all")) {
    await handleResetAll(chatId, userId);
    return;
  }

  if (text.startsWith("/assign")) {
    await handleAssignBatch(chatId, userId, text);
    return;
  }

  await sendMessage(config.botToken, chatId, "Unknown command. Use /help.");
};

const handleCallback = async (callback: TelegramCallbackQuery): Promise<void> => {
  const chatId = callback.message?.chat.id;
  const data = callback.data ?? "";
  const userId = callback.from.id;
  if (!chatId) {
    await answerCallbackQuery(config.botToken, callback.id);
    return;
  }

  await registerAgent(callback.from);

  if (!isAllowed(userId)) {
    await answerCallbackQuery(config.botToken, callback.id, "Not authorized.");
    return;
  }

  if (data.startsWith("claim:")) {
    await answerCallbackQuery(config.botToken, callback.id);
    const batch = Number.parseInt(data.slice(6), 10);
    if (Number.isNaN(batch) || batch < config.minBatch || batch > config.maxBatch) {
      await sendMessage(config.botToken, chatId, "Invalid batch.");
      return;
    }
    await handleClaimRequest(chatId, userId, batch);
    return;
  }

  const action = parseActionData(data);
  if (action) {
    await answerCallbackQuery(config.botToken, callback.id);
    const result = await markCurrent(
      userId,
      action.kind === "sent" ? "sent" : "skipped",
      action.numberId
    );
    if (result === "stale") {
      await sendMessage(config.botToken, chatId, "Stale action. Tap Next.");
      return;
    }
    if (result === "invalid") {
      await sendMessage(config.botToken, chatId, "Cannot process this number.");
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
    await sendAssignedBatchProgress(chatId, userId);
    return;
  }

  if (data === "undo") {
    await answerCallbackQuery(config.botToken, callback.id);
    await undoLast(chatId, userId);
    return;
  }

  if (data === "mybatch") {
    await answerCallbackQuery(config.botToken, callback.id);
    await sendAssignedBatch(chatId, userId);
    return;
  }

  if (data === "release") {
    await answerCallbackQuery(config.botToken, callback.id);
    await handleReleaseRequest(chatId, userId);
    return;
  }

  await answerCallbackQuery(config.botToken, callback.id, "Unknown action");
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

const loadOffset = async (): Promise<number | undefined> => {
  const offsetRaw = await redis.get<string | number | null>(keys.runtimeOffset());
  if (offsetRaw === null) {
    return undefined;
  }

  const parsed = asInt(offsetRaw);
  return parsed > 0 ? parsed : undefined;
};

const startPolling = async (): Promise<void> => {
  await deleteWebhook(config.botToken, false);
  let offset = await loadOffset();
  console.log("Polling started.");

  while (true) {
    try {
      const updates = await getUpdates(config.botToken, offset, config.pollTimeoutSeconds);
      updates.sort((a, b) => a.update_id - b.update_id);

      for (const update of updates) {
        try {
          await processUpdate(update);
        } catch (error) {
          console.error("Failed to process update", update.update_id, error);
        }
        offset = update.update_id + 1;
        await redis.set(keys.runtimeOffset(), offset);
      }
    } catch (error) {
      console.error("Polling loop error", error);
      await sleep(config.pollRetryDelayMs);
    }
  }
};

const port = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 3000;
createServer((_req, res) => {
  res.writeHead(200);
  res.end("ok");
}).listen(port, "0.0.0.0", () => {
  console.log(`Health check server listening on port ${port}`);
});

void startPolling().catch((error: unknown) => {
  console.error("Fatal startup error", error);
  process.exit(1);
});
