import { reviewerIdentity } from '../sync/identity.js';
import { normalizeReviewState, type ReviewStatus } from '../sync/mapper.js';
import type { BbAccount, BbPullRequest } from './types.js';

export interface PrReviewer {
  /** Stable identity: Bitbucket account UUID (normalized), or `acct:<account_id>` fallback. */
  id: string;
  displayName: string;
  /** Raw Bitbucket participant state, kept for logging. */
  rawState: string;
  /** Undefined when Bitbucket reports a state we do not recognise. */
  status: ReviewStatus | undefined;
}

export interface ExtractedReviewers {
  reviewers: PrReviewer[];
  /** Accounts we could not identify (no uuid and no account_id). */
  skipped: string[];
}

/**
 * One entry per person reviewing the PR:
 *  - everyone in `reviewers` (Pending until they act), plus
 *  - any participant who approved / requested changes without being an assigned reviewer.
 * Participants who only commented are not reviewers.
 */
export function extractReviewers(pr: BbPullRequest): ExtractedReviewers {
  const byId = new Map<string, PrReviewer>();
  const skipped: string[] = [];

  const add = (account: BbAccount, participant?: { approved: boolean; state?: string | null }) => {
    const id = reviewerIdentity(account);
    if (!id) {
      skipped.push(account.display_name ?? '(unknown account)');
      return;
    }
    const { status, raw } = normalizeReviewState(participant?.state, participant?.approved ?? false);
    byId.set(id, { id, displayName: displayName(account), rawState: raw, status });
  };

  for (const account of pr.reviewers ?? []) add(account);

  for (const p of pr.participants ?? []) {
    const isAssigned = p.role === 'REVIEWER';
    const hasActed = p.approved || (p.state != null && p.state !== '');
    if (isAssigned || hasActed) add(p.user, p);
  }

  return { reviewers: [...byId.values()], skipped };
}

function displayName(account: BbAccount): string {
  return (account.display_name ?? account.nickname ?? '').trim() || '(unknown)';
}
