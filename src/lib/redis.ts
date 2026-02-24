import { Redis } from "@upstash/redis";
import { getConfig } from "./config.js";

let cachedClient: Redis | null = null;

export const getRedis = (): Redis => {
  if (cachedClient) {
    return cachedClient;
  }

  const config = getConfig();
  cachedClient = new Redis({
    url: config.redisUrl,
    token: config.redisToken
  });
  return cachedClient;
};
