export interface AppConfig {
  botToken: string;
  webhookSecret: string;
  redisUrl: string;
  redisToken: string;
  redisPrefix: string;
}

const requiredEnv = (name: string): string => {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

let cachedConfig: AppConfig | null = null;

export const getConfig = (): AppConfig => {
  if (cachedConfig) {
    return cachedConfig;
  }

  cachedConfig = {
    botToken: requiredEnv("BOT_TOKEN"),
    webhookSecret: requiredEnv("TELEGRAM_WEBHOOK_SECRET"),
    redisUrl: requiredEnv("UPSTASH_REDIS_REST_URL"),
    redisToken: requiredEnv("UPSTASH_REDIS_REST_TOKEN"),
    redisPrefix: process.env.REDIS_PREFIX?.trim() || "smsbot"
  };

  return cachedConfig;
};
