import type { BbAccount } from '../bitbucket/types.js';

/**
 * Bitbucket UUIDs look like "{a1b2c3d4-...}". Normalize to lower-case with braces so the
 * same account always yields the same key regardless of how it was written.
 */
export function normalizeUuid(uuid: string): string {
  const bare = uuid.trim().replace(/^\{|\}$/g, '').toLowerCase();
  return `{${bare}}`;
}

/** Stable reviewer identity: account UUID, falling back to Atlassian account_id. Null if neither exists. */
export function reviewerIdentity(account: BbAccount): string | null {
  if (account.uuid?.trim()) return normalizeUuid(account.uuid);
  if (account.account_id?.trim()) return `acct:${account.account_id.trim()}`;
  return null;
}

/**
 * Deterministic row key: one row per (PR, reviewer). Uses the reviewer's UUID rather than
 * their display name so renames never create a second row.
 *   buildSyncKey(123, "{ABC}") → "123:{abc}"
 */
export function buildSyncKey(prId: number, reviewerId: string): string {
  if (!Number.isInteger(prId) || prId <= 0) throw new Error(`Invalid PR id: ${prId}`);
  if (!reviewerId) throw new Error('Reviewer identity is required');
  const id = reviewerId.startsWith('acct:') ? reviewerId : normalizeUuid(reviewerId);
  return `${prId}:${id}`;
}

export function parseSyncKey(key: string): { prId: number; reviewerId: string } | null {
  const m = /^(\d+):(.+)$/.exec(key.trim());
  if (!m) return null;
  return { prId: Number(m[1]), reviewerId: m[2]! };
}

/** Case/whitespace-insensitive name comparison, used only to adopt hand-entered legacy rows. */
export function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Parse a PR ID cell that may come back as a number, "123", or "123.0". */
export function parsePrId(value: unknown): number | null {
  if (value && typeof value === 'object' && 'text' in value) return parsePrId((value as { text: unknown }).text);
  if (typeof value === 'number') return Number.isInteger(value) && value > 0 ? value : null;
  if (typeof value === 'string') {
    const m = /^\s*#?(\d+)(\.0+)?\s*$/.exec(value);
    return m ? Number(m[1]) : null;
  }
  return null;
}
