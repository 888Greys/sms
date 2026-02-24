import { Redis } from "@upstash/redis";
import { getConfig } from "./config.js";

let client: Redis | null = null;

export const getRedis = (): Redis => {
  if (client) {
    return client;
  }

  const config = getConfig();
  client = new Redis({
    url: config.redisUrl,
    token: config.redisToken
  });

  return client;
};
