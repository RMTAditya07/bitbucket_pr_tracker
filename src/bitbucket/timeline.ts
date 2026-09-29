import { shortHash, type PrTimeline, type ReviewEvent, type ReviewThread, type TimelineSource } from '../sync/queue.js';
import { reviewerIdentity } from '../sync/identity.js';
import type { BitbucketClient } from './client.js';
import type { BbAccount, BbActivity, BbComment, BbCommit, BbPullRequest } from './types.js';

/** Safety cap on commit-list paging (50 per page). Longer PRs fall back to push counts. */
const MAX_COMMIT_PAGES = 4;

/** Fetches a PR's review history: `/activity`, `/commits` and `/comments`. Three+ requests per PR. */
export class BitbucketTimelines implements TimelineSource {
  constructor(private readonly client: BitbucketClient) {}

  async get(pr: BbPullRequest): Promise<PrTimeline> {
    const base = `${this.client.repoPath()}/pullrequests/${pr.id}`;
    const activity: BbActivity[] = [];
    for await (const a of this.client.paginate<BbActivity>(`${base}/activity?pagelen=50`)) activity.push(a);

    const commits: string[] = [];
    let pages = 0;
    let next: string | undefined = `${base}/commits?pagelen=50&fields=next,values.hash`;
    while (next && pages++ < MAX_COMMIT_PAGES) {
      const page: { values: BbCommit[]; next?: string } | null = await this.client.get(next);
      if (!page) break;
      commits.push(...page.values.map((c) => shortHash(c.hash)));
      next = page.next;
    }
    return { ...parseActivity(activity), commits, threads: await this.threads(pr) };
  }

  async threads(pr: BbPullRequest): Promise<ReviewThread[]> {
    const comments: BbComment[] = [];
    // `resolution` comes back as {} unless its fields are requested explicitly.
    const path = `${this.client.repoPath()}/pullrequests/${pr.id}/comments?pagelen=100&fields=%2Bvalues.resolution.*`;
    for await (const c of this.client.paginate<BbComment>(path)) comments.push(c);
    return parseThreads(comments);
  }
}

/** Top-level, published, non-deleted comments → threads with their resolution time. */
export function parseThreads(comments: BbComment[]): ReviewThread[] {
  const threads: ReviewThread[] = [];
  for (const c of comments) {
    if (c.parent || c.deleted || c.pending || !c.created_on) continue;
    const openedBy = c.user ? reviewerIdentity(c.user) : null;
    if (!openedBy) continue;
    // Resolving a thread bumps the comment's updated_on: the fallback if the resolution time is missing.
    const resolvedAt = c.resolution ? (c.resolution.created_on ?? c.updated_on ?? c.created_on) : null;
    threads.push({ openedBy, openedAt: c.created_on, resolvedAt });
  }
  return threads.sort((a, b) => Date.parse(a.openedAt) - Date.parse(b.openedAt));
}

/**
 * Activity entries → pushes (head-commit changes), review events and merge time, oldest first.
 * `update` entries repeat the head commit on every edit; only changes of commit count as pushes.
 */
export function parseActivity(entries: BbActivity[]): Omit<PrTimeline, 'commits' | 'threads'> {
  const updates: Array<{ at: string; hash: string; state: string }> = [];
  const reviews: ReviewEvent[] = [];
  const review = (kind: ReviewEvent['kind'], user: BbAccount | undefined, at: string | undefined) => {
    const id = user ? reviewerIdentity(user) : null;
    if (id && at && !Number.isNaN(Date.parse(at))) reviews.push({ reviewerId: id, kind, at });
  };

  for (const e of entries) {
    if (e.update?.date) {
      updates.push({
        at: e.update.date,
        hash: shortHash(e.update.source?.commit?.hash ?? ''),
        state: (e.update.state ?? '').toUpperCase(),
      });
    } else if (e.approval) {
      review('approval', e.approval.user, e.approval.date);
    } else if (e.changes_requested ?? e.request_changes) {
      const c = (e.changes_requested ?? e.request_changes)!;
      review('changes_requested', c.user, c.date);
    } else if (e.comment && !e.comment.deleted) {
      review('comment', e.comment.user, e.comment.created_on);
    }
  }

  const byTime = <T extends { at: string }>(a: T, b: T) => Date.parse(a.at) - Date.parse(b.at);
  updates.sort(byTime);
  reviews.sort(byTime);

  const pushes: PrTimeline['pushes'] = [];
  for (const u of updates) {
    if (u.hash && u.hash !== pushes.at(-1)?.hash) pushes.push({ hash: u.hash, at: u.at });
  }
  const mergedAt = updates.find((u) => u.state === 'MERGED')?.at ?? null;
  return { pushes, reviews, mergedAt };
}

/**
 * Anything that can change a PR's timeline: a push moves the head commit, and approvals,
 * change requests and comments move a participant's `participated_on` (approving may not
 * bump the PR's `updated_on`, so that alone is not enough).
 */
export function timelineFingerprint(pr: BbPullRequest): string {
  const participants = (pr.participants ?? [])
    .map((p) => `${reviewerIdentity(p.user) ?? '?'}=${p.state ?? (p.approved ? 'approved' : '')}@${p.participated_on ?? ''}`)
    .sort();
  return [pr.state, pr.updated_on, shortHash(pr.source.commit?.hash ?? ''), ...participants].join('|');
}

function awaitingAuthor(pr: BbPullRequest): boolean {
  return pr.state === 'OPEN' && (pr.participants ?? []).some((p) => p.state === 'changes_requested');
}

export interface CachedTimeline {
  fingerprint: string;
  timeline: PrTimeline;
}

/**
 * Re-fetches a PR's timeline only when its fingerprint changed, so the ~90 open PRs re-checked
 * every run cost no extra requests unless something happened on them. `entries()` holds only the
 * PRs used this run, which keeps the persisted cache from growing with closed PRs.
 *
 * Exception: resolving a comment thread may leave the fingerprint unchanged, so an open PR with a
 * change request outstanding gets its threads (one request) refreshed every run.
 */
export class CachingTimelines implements TimelineSource {
  private readonly used = new Map<number, CachedTimeline>();
  fetched = 0;
  threadsRefreshed = 0;

  constructor(
    private readonly inner: TimelineSource,
    private readonly previous: Record<string, CachedTimeline> = {},
  ) {}

  async get(pr: BbPullRequest): Promise<PrTimeline> {
    const fingerprint = timelineFingerprint(pr);
    const hit = this.previous[String(pr.id)];
    if (hit?.fingerprint === fingerprint && hit.timeline.threads) {
      let timeline = hit.timeline;
      if (this.inner.threads && awaitingAuthor(pr)) {
        timeline = { ...timeline, threads: await this.inner.threads(pr) };
        this.threadsRefreshed++;
      }
      this.used.set(pr.id, { fingerprint, timeline });
      return timeline;
    }
    const timeline = await this.inner.get(pr);
    this.fetched++;
    this.used.set(pr.id, { fingerprint, timeline });
    return timeline;
  }

  entries(): Record<string, CachedTimeline> {
    return Object.fromEntries([...this.used].map(([id, e]) => [String(id), e]));
  }
}
