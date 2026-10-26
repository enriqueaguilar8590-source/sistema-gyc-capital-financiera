type Data = Record<string, unknown>;
export type SyncCheckpoint = { userId: string; base: Data | null };

export function mayRestorePending(checkpoint: SyncCheckpoint | null, userId: string) {
  return checkpoint?.userId === userId;
}

export function requireSaveResult(error: { message: string } | null, version: number | null) {
  if (error) throw new Error(error.message);
  return version;
}