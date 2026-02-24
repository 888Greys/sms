export interface KeyFactory {
  batchNumbers(batch: number): string;
  batchPending(batch: number): string;
  batchSent(batch: number): string;
  batchSkipped(batch: number): string;
  batchTotal(batch: number): string;
  number(id: string): string;
  agentBatch(userId: number): string;
  agentCurrent(userId: number): string;
  agentHistory(userId: number): string;
}

export const createKeys = (prefix: string): KeyFactory => {
  const root = `${prefix}:v1`;
  return {
    batchNumbers: (batch) => `${root}:batch:${batch}:numbers`,
    batchPending: (batch) => `${root}:batch:${batch}:pending`,
    batchSent: (batch) => `${root}:batch:${batch}:sent`,
    batchSkipped: (batch) => `${root}:batch:${batch}:skipped`,
    batchTotal: (batch) => `${root}:batch:${batch}:total`,
    number: (id) => `${root}:number:${id}`,
    agentBatch: (userId) => `${root}:agent:${userId}:batch`,
    agentCurrent: (userId) => `${root}:agent:${userId}:current`,
    agentHistory: (userId) => `${root}:agent:${userId}:history`
  };
};

export const parseBatchFromNumberId = (numberId: string): number | null => {
  const match = /^b(\d+):n\d+$/.exec(numberId);
  if (!match) {
    return null;
  }
  return Number.parseInt(match[1], 10);
};
