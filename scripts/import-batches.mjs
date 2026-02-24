import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { Redis } from "@upstash/redis";

dotenv.config();

const requiredEnv = (name) => {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

const redis = new Redis({
  url: requiredEnv("UPSTASH_REDIS_REST_URL"),
  token: requiredEnv("UPSTASH_REDIS_REST_TOKEN")
});

const prefix = process.env.REDIS_PREFIX?.trim() || "smsbot";
const root = `${prefix}:v1`;

const key = {
  batchNumbers: (batch) => `${root}:batch:${batch}:numbers`,
  batchPending: (batch) => `${root}:batch:${batch}:pending`,
  batchSent: (batch) => `${root}:batch:${batch}:sent`,
  batchSkipped: (batch) => `${root}:batch:${batch}:skipped`,
  batchTotal: (batch) => `${root}:batch:${batch}:total`,
  batchOwner: (batch) => `${root}:batch:${batch}:owner`,
  number: (numberId) => `${root}:number:${numberId}`,
  agentBatch: (agentId) => `${root}:agent:${agentId}:batch`,
  agentCurrent: (agentId) => `${root}:agent:${agentId}:current`,
  agentHistory: (agentId) => `${root}:agent:${agentId}:history`,
  agentsAll: () => `${root}:agents:all`,
  runtimeOffset: () => `${root}:runtime:offset`
};

const thisFile = fileURLToPath(import.meta.url);
const scriptsDir = path.dirname(thisFile);
const projectRoot = path.resolve(scriptsDir, "..");
const batchesDir = path.join(projectRoot, "sms_batches");

const parseNumbers = (content) => {
  const seen = new Set();
  const output = [];
  for (const raw of content.split(/\r?\n/)) {
    const value = raw.trim();
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    output.push(value);
  }
  return output;
};

const toBatchNumber = (filename) => {
  const match = /^batch_(\d+)\.txt$/.exec(filename);
  return match ? Number.parseInt(match[1], 10) : null;
};

const chunk = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
};

const deleteMany = async (keys) => {
  if (keys.length === 0) {
    return;
  }
  for (const group of chunk(keys, 200)) {
    await redis.del(...group);
  }
};

const entries = await fs.readdir(batchesDir, { withFileTypes: true });
const batchFiles = entries
  .filter((entry) => entry.isFile() && /^batch_\d+\.txt$/.test(entry.name))
  .map((entry) => entry.name)
  .sort((a, b) => {
    const batchA = toBatchNumber(a) ?? 0;
    const batchB = toBatchNumber(b) ?? 0;
    return batchA - batchB;
  });

if (batchFiles.length === 0) {
  throw new Error(`No batch files found in ${batchesDir}`);
}

let totalImported = 0;
for (const filename of batchFiles) {
  const batch = toBatchNumber(filename);
  if (!batch) {
    continue;
  }

  const fullPath = path.join(batchesDir, filename);
  const content = await fs.readFile(fullPath, "utf8");
  const numbers = parseNumbers(content);
  const ids = numbers.map((_, idx) => `b${batch}:n${idx + 1}`);

  const existingIdsRaw = await redis.lrange(key.batchNumbers(batch), 0, -1);
  const existingIds = Array.isArray(existingIdsRaw)
    ? existingIdsRaw.filter((value) => typeof value === "string")
    : [];

  const staleKeys = [
    key.batchNumbers(batch),
    key.batchPending(batch),
    key.batchSent(batch),
    key.batchSkipped(batch),
    key.batchTotal(batch),
    key.batchOwner(batch),
    ...existingIds.map((id) => key.number(id))
  ];
  await deleteMany(staleKeys);

  const pipeline = redis.pipeline();
  if (ids.length > 0) {
    pipeline.rpush(key.batchNumbers(batch), ...ids);
    pipeline.rpush(key.batchPending(batch), ...ids);
  }
  pipeline.set(key.batchTotal(batch), ids.length);

  for (const [idx, numberId] of ids.entries()) {
    pipeline.hset(key.number(numberId), {
      phone: numbers[idx],
      batch: String(batch),
      status: "pending",
      position: String(idx + 1)
    });
  }

  await pipeline.exec();
  totalImported += ids.length;
  console.log(`Imported batch ${batch}: ${ids.length} numbers`);
}

const allAgentsRaw = await redis.smembers(key.agentsAll());
const allAgents = Array.isArray(allAgentsRaw)
  ? allAgentsRaw.filter((value) => typeof value === "string")
  : [];

for (const agentId of allAgents) {
  await deleteMany([
    key.agentBatch(agentId),
    key.agentCurrent(agentId),
    key.agentHistory(agentId)
  ]);
}

await redis.del(key.runtimeOffset());

console.log(`Done. Total imported: ${totalImported}`);
