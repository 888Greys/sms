export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
}

export interface TelegramMessage {
  message_id: number;
  text?: string;
  from?: TelegramUser;
  chat: TelegramChat;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  data?: string;
  message?: TelegramMessage;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

interface TelegramResponse<T> {
  ok: boolean;
  result: T;
}

const telegramApi = (token: string): string => `https://api.telegram.org/bot${token}`;

const callTelegram = async <T>(
  token: string,
  method: string,
  payload: Record<string, unknown>
): Promise<T> => {
  const response = await fetch(`${telegramApi(token)}/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Telegram API ${method} failed: ${response.status} ${body}`);
  }

  const parsed = JSON.parse(body) as TelegramResponse<T>;
  if (!parsed.ok) {
    throw new Error(`Telegram API ${method} returned ok=false`);
  }
  return parsed.result;
};

export const sendMessage = async (
  token: string,
  chatId: number,
  text: string,
  replyMarkup?: InlineKeyboardMarkup
): Promise<void> => {
  await callTelegram(token, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    ...(replyMarkup ? { reply_markup: replyMarkup } : {})
  });
};

export const answerCallbackQuery = async (
  token: string,
  callbackQueryId: string,
  text?: string
): Promise<void> => {
  await callTelegram(token, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text } : {})
  });
};

export const getUpdates = async (
  token: string,
  offset: number | undefined,
  timeoutSeconds: number
): Promise<TelegramUpdate[]> => {
  return callTelegram<TelegramUpdate[]>(token, "getUpdates", {
    ...(typeof offset === "number" ? { offset } : {}),
    timeout: timeoutSeconds,
    allowed_updates: ["message", "callback_query"]
  });
};

export const deleteWebhook = async (
  token: string,
  dropPendingUpdates: boolean
): Promise<void> => {
  await callTelegram(token, "deleteWebhook", {
    drop_pending_updates: dropPendingUpdates
  });
};
