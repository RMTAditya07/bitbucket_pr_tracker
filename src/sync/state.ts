import { readFile, rename, writeFile } from 'node:fs/promises';

/**
 * Incremental-sync watermark. Losing this file is harmless: the next run falls back to the
 * initial lookback window, and idempotent upserts mean re-processing creates no duplicates.
 */
export interface SyncState {
  /** Start time of the last run that finished with zero failures. */
  lastSuccessfulSyncStartedAt: string;
  /** Interactives list seen by that run; a change triggers a re-check of unnamed PRs. */
  interactivesFingerprint?: string | null;
}

/** Overlap re-scanned each run to absorb clock skew and in-flight Bitbucket updates. */
export const WATERMARK_OVERLAP_MS = 5 * 60_000;

export async function readState(path: string): Promise<SyncState | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<SyncState>;
    if (parsed.lastSuccessfulSyncStartedAt && !Number.isNaN(Date.parse(parsed.lastSuccessfulSyncStartedAt))) {
      return {
        lastSuccessfulSyncStartedAt: parsed.lastSuccessfulSyncStartedAt,
        interactivesFingerprint: parsed.interactivesFingerprint ?? null,
      };
    }
  } catch {
    // missing or corrupt → treat as first run
  }
  return null;
}

export async function writeState(path: string, state: SyncState): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  await rename(tmp, path); // atomic replace
}

export function sinceFromState(state: SyncState | null, initialLookbackDays: number, now: Date): Date | null {
  if (state) return new Date(Date.parse(state.lastSuccessfulSyncStartedAt) - WATERMARK_OVERLAP_MS);
  if (initialLookbackDays <= 0) return null; // 0 = all history
  return new Date(now.getTime() - initialLookbackDays * 86_400_000);
}
