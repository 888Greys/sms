export interface AppConfig {
  botToken: string;
  redisUrl: string;
  redisToken: string;
  redisPrefix: string;
  minBatch: number;
  maxBatch: number;
  pollTimeoutSeconds: number;
  pollRetryDelayMs: number;
  adminUserIds: Set<number>;
}

const requiredEnv = (name: string): string => {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

const parseIntEnv = (name: string, fallback: number): number => {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be a number.`);
  }
  return parsed;
};

const parseAdminUserIds = (): Set<number> => {
  const value = process.env.ADMIN_USER_IDS;
  if (!value || value.trim().length === 0) {
    return new Set<number>();
  }

  const ids = value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => Number.parseInt(part, 10))
    .filter((id) => Number.isFinite(id));
  return new Set(ids);
};

let cached: AppConfig | null = null;

export const getConfig = (): AppConfig => {
  if (cached) {
    return cached;
  }

  const minBatch = parseIntEnv("MIN_BATCH", 1);
  const maxBatch = parseIntEnv("MAX_BATCH", 10);
  if (minBatch > maxBatch) {
    throw new Error("MIN_BATCH cannot be greater than MAX_BATCH.");
  }

  cached = {
    botToken: requiredEnv("BOT_TOKEN"),
    redisUrl: requiredEnv("UPSTASH_REDIS_REST_URL"),
    redisToken: requiredEnv("UPSTASH_REDIS_REST_TOKEN"),
    redisPrefix: process.env.REDIS_PREFIX?.trim() || "smsbot",
    minBatch,
    maxBatch,
    pollTimeoutSeconds: parseIntEnv("POLL_TIMEOUT_SECONDS", 50),
    pollRetryDelayMs: parseIntEnv("POLL_RETRY_DELAY_MS", 2000),
    adminUserIds: parseAdminUserIds()
  };
  return cached;
};
