export interface KeyFactory {
  batchNumbers(batch: number): string;
  batchPending(batch: number): string;
  batchSent(batch: number): string;
  batchSkipped(batch: number): string;
  batchTotal(batch: number): string;
  batchOwner(batch: number): string;
  number(id: string): string;
  agentBatch(userId: number): string;
  agentCurrent(userId: number): string;
  agentHistory(userId: number): string;
  agentProfile(userId: number): string;
  agentsAll(): string;
  runtimeOffset(): string;
}

export const createKeys = (prefix: string): KeyFactory => {
  const root = `${prefix}:v1`;
  return {
    batchNumbers: (batch) => `${root}:batch:${batch}:numbers`,
    batchPending: (batch) => `${root}:batch:${batch}:pending`,
    batchSent: (batch) => `${root}:batch:${batch}:sent`,
    batchSkipped: (batch) => `${root}:batch:${batch}:skipped`,
    batchTotal: (batch) => `${root}:batch:${batch}:total`,
    batchOwner: (batch) => `${root}:batch:${batch}:owner`,
    number: (id) => `${root}:number:${id}`,
    agentBatch: (userId) => `${root}:agent:${userId}:batch`,
    agentCurrent: (userId) => `${root}:agent:${userId}:current`,
    agentHistory: (userId) => `${root}:agent:${userId}:history`,
    agentProfile: (userId) => `${root}:agent:${userId}:profile`,
    agentsAll: () => `${root}:agents:all`,
    runtimeOffset: () => `${root}:runtime:offset`
  };
};

export const parseBatchFromNumberId = (numberId: string): number | null => {
  const match = /^b(\d+):n\d+$/.exec(numberId);
  if (!match) {
    return null;
  }
  const batchGroup = match.at(1);
  if (!batchGroup) {
    return null;
  }
  return Number.parseInt(batchGroup, 10);
};
