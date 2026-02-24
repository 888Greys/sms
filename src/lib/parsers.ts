export interface ParsedAction {
  kind: "sent" | "skip";
  numberId: string;
}

const parseBatchCommandArg = (
  command: string,
  text: string,
  minBatch: number,
  maxBatch: number
): number | null => {
  const pattern = new RegExp(`^\\/${command}(?:@\\w+)?\\s+(\\d+)$`);
  const match = pattern.exec(text.trim());
  if (!match) {
    return null;
  }
  const batchGroup = match.at(1);
  if (!batchGroup) {
    return null;
  }
  const batch = Number.parseInt(batchGroup, 10);
  if (Number.isNaN(batch) || batch < minBatch || batch > maxBatch) {
    return null;
  }
  return batch;
};

export const parseClaimArg = (
  text: string,
  minBatch: number,
  maxBatch: number
): number | null => parseBatchCommandArg("claim", text, minBatch, maxBatch);

export const parseForceReleaseArg = (
  text: string,
  minBatch: number,
  maxBatch: number
): number | null => parseBatchCommandArg("force_release", text, minBatch, maxBatch);

export const parseActionData = (data: string): ParsedAction | null => {
  if (data.startsWith("sent:")) {
    return { kind: "sent", numberId: data.slice(5) };
  }
  if (data.startsWith("skip:")) {
    return { kind: "skip", numberId: data.slice(5) };
  }
  return null;
};
