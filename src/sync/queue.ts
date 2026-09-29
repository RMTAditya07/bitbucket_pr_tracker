/**
 * Review-queue derivation: where each (PR, reviewer) pair is stuck and since when. Pure
 * functions over a PR and its review history; no I/O.
 */
import { normalizeName, reviewerIdentity } from './identity.js';
import type { BbPullRequest } from '../bitbucket/types.js';
import type { ReviewStatus } from './mapper.js';

export type ReviewKind = 'approval' | 'changes_requested' | 'comment';

export interface ReviewEvent {
  /** Same identity as PrReviewer.id (normalized UUID or `acct:<id>`). */
  reviewerId: string;
  kind: ReviewKind;
  at: string;
}

/** The PR's head commit changed (creation or a push). */
export interface PushEvent {
  hash: string;
  at: string;
}

/** A top-level comment and its replies. Resolving it is how an author hands feedback back. */
export interface ReviewThread {
  /** Who opened the thread (same identity as ReviewEvent.reviewerId). */
  openedBy: string;
  openedAt: string;
  resolvedAt: string | null;
}

/** Review history of one PR, from Bitbucket activity + commits + comments. Lists are oldest first. */
export interface PrTimeline {
  pushes: PushEvent[];
  reviews: ReviewEvent[];
  mergedAt: string | null;
  /** Commit hashes on the PR, newest first (12-char prefixes). */
  commits: string[];
  threads: ReviewThread[];
}

export interface TimelineSource {
  get(pr: BbPullRequest): Promise<PrTimeline>;
  /**
   * Just the comment threads. Resolving a thread may not change anything else on the PR, so a
   * cache refreshes these on every run for PRs where changes were requested.
   */
  threads?(pr: BbPullRequest): Promise<ReviewThread[]>;
}

export type QueueState =
  | 'Waiting for Review'
  | 'Changes Requested'
  | 'Waiting for Re-review'
  | 'Approved'
  | 'Blocked by Dependency'
  | 'Draft'
  | 'Merged'
  | 'Declined'
  | 'Superseded'
  /** The reviewer was removed from the PR. */
  | 'Removed'
  /** On the PR, but not an owner of its review (not on the rota, has not engaged). */
  | 'Optional'
  /** L2 reviewer: every L1 owner has approved, the L2 review is due. */
  | 'Waiting for L2';

export interface ReviewerQueue {
  /** undefined when the PR state is unrecognised; the cell is then left alone. */
  state: QueueState | undefined;
  /** Who has to act next: the reviewer, the PR author, or the blocking PR(s). '' = nobody. */
  waitingOn: string;
  /** ISO instant the current wait started; null when nothing is waiting. */
  waitingSince: string | null;
  /** 1 for the first review, +1 for each new revision this reviewer has to look at. '' = closed. */
  reviewRound: number | '';
  /** Commits pushed after this reviewer's last review. '' = has not reviewed yet. */
  commitsSinceReview: number | '';
}

const CLOSED: Record<string, QueueState> = { MERGED: 'Merged', DECLINED: 'Declined', SUPERSEDED: 'Superseded' };

export function shortHash(hash: string): string {
  return hash.trim().slice(0, 12).toLowerCase();
}

/**
 * Queue position of one reviewer on one PR.
 *
 *  - Requested Changes, no push since      → Changes Requested (waiting on the author)
 *  - Reviewed (any way), pushed since       → Waiting for Re-review (waiting on the reviewer)
 *  - Pending, nothing reviewed since head   → Waiting for Review
 *  - Approved, a dependency still open      → Blocked by Dependency. Review is not blocked by
 *    dependencies (review against the combined baseline); only merging is.
 *
 * A comment counts as having reviewed the revision it was made on, so a push after comments
 * puts the PR back in the reviewer's queue even without a formal "Request changes".
 *
 * The author hands feedback back by pushing, or by resolving every thread the reviewer opened
 * (fixed elsewhere, or explained in a reply). A reply alone does not ("will fix tomorrow").
 */
export function reviewerQueue(input: {
  pr: BbPullRequest;
  timeline: PrTimeline;
  reviewerId: string;
  reviewerName: string;
  status: ReviewStatus | undefined;
  openDependencies: number[];
}): ReviewerQueue {
  const { pr, timeline, reviewerId, reviewerName, status, openDependencies } = input;
  const state = pr.state.trim().toUpperCase();
  if (CLOSED[state]) {
    return { state: CLOSED[state], waitingOn: '', waitingSince: null, reviewRound: '', commitsSinceReview: '' };
  }
  if (state !== 'OPEN') {
    return { state: undefined, waitingOn: '', waitingSince: null, reviewRound: '', commitsSinceReview: '' };
  }

  const author = pr.author?.display_name?.trim() ?? '';
  const head = shortHash(pr.source.commit?.hash ?? timeline.pushes.at(-1)?.hash ?? '');
  const mine = timeline.reviews.filter((r) => r.reviewerId === reviewerId);
  const last = mine.at(-1);
  const reviewedHead = last ? revisionAt(timeline, last.at) : null;
  const pushedSince = last !== undefined && reviewedHead !== head;
  const commitsSinceReview = last ? countCommitsSince(timeline, reviewedHead!, last.at, pushedSince) : '';
  const revisions = new Set(mine.map((r) => revisionAt(timeline, r.at)));
  const round = (waiting: boolean) => {
    if (waiting) revisions.add(head);
    return Math.max(1, revisions.size);
  };

  if (pr.draft) {
    return { state: 'Draft', waitingOn: author, waitingSince: pr.created_on, reviewRound: round(false), commitsSinceReview };
  }

  if (status === 'Approved') {
    const approvedAt = [...mine].reverse().find((r) => r.kind === 'approval')?.at ?? last?.at ?? null;
    if (openDependencies.length > 0) {
      return {
        state: 'Blocked by Dependency',
        waitingOn: openDependencies.map((id) => `#${id}`).join(', '),
        waitingSince: approvedAt,
        reviewRound: round(false),
        commitsSinceReview,
      };
    }
    return { state: 'Approved', waitingOn: '', waitingSince: null, reviewRound: round(false), commitsSinceReview };
  }

  if (pushedSince) {
    return {
      state: 'Waiting for Re-review',
      waitingOn: reviewerName,
      waitingSince: firstPushAfter(timeline, last!.at) ?? last!.at,
      reviewRound: round(true),
      commitsSinceReview,
    };
  }

  const resolvedAt = last ? allThreadsResolvedAt(timeline, reviewerId, lastRequestAt(mine) ?? last.at) : null;
  if (resolvedAt) {
    return {
      state: 'Waiting for Re-review',
      waitingOn: reviewerName,
      waitingSince: resolvedAt,
      reviewRound: Math.max(1, revisions.size) + 1,
      commitsSinceReview,
    };
  }

  if (status === 'Requested Changes') {
    const requestedAt = [...mine].reverse().find((r) => r.kind === 'changes_requested')?.at ?? last?.at;
    return {
      state: 'Changes Requested',
      waitingOn: author,
      waitingSince: requestedAt ?? pr.updated_on,
      reviewRound: round(false),
      commitsSinceReview,
    };
  }

  return {
    state: 'Waiting for Review',
    waitingOn: reviewerName,
    waitingSince: pr.created_on,
    reviewRound: round(true),
    commitsSinceReview,
  };
}

/** Earliest approval / change request / comment by anyone other than the PR author. */
export function firstReviewAt(pr: BbPullRequest, timeline: PrTimeline): string | null {
  const authorId = pr.author ? reviewerIdentity(pr.author) : null;
  return timeline.reviews.find((r) => r.reviewerId !== authorId)?.at ?? null;
}

function lastRequestAt(mine: ReviewEvent[]): string | undefined {
  return [...mine].reverse().find((r) => r.kind === 'changes_requested')?.at;
}

/**
 * When the reviewer's feedback was handed back by resolving threads: the time the last of their
 * threads was resolved, if all of them are resolved and that happened after `after` (their last
 * change request, else their last review). Null if they opened no threads.
 */
function allThreadsResolvedAt(timeline: PrTimeline, reviewerId: string, after: string): string | null {
  const mine = (timeline.threads ?? []).filter((t) => t.openedBy === reviewerId);
  if (mine.length === 0 || mine.some((t) => !t.resolvedAt)) return null;
  const last = mine.map((t) => t.resolvedAt!).reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b));
  return Date.parse(last) > Date.parse(after) ? last : null;
}

/** Head commit at instant `at`: the last push at or before it (the first push if none). */
function revisionAt(timeline: PrTimeline, at: string): string {
  const t = Date.parse(at);
  let hash = timeline.pushes[0]?.hash ?? '';
  for (const p of timeline.pushes) {
    if (Date.parse(p.at) <= t) hash = p.hash;
    else break;
  }
  return shortHash(hash);
}

function firstPushAfter(timeline: PrTimeline, at: string): string | undefined {
  const t = Date.parse(at);
  return timeline.pushes.find((p) => Date.parse(p.at) > t)?.at;
}

/**
 * Commits newer than the reviewed revision, counted in the PR's commit list. After a rebase or
 * force-push the reviewed commit is gone; fall back to the number of pushes since the review.
 */
function countCommitsSince(timeline: PrTimeline, reviewedHead: string, reviewedAt: string, pushedSince: boolean): number {
  if (!pushedSince) return 0;
  const i = timeline.commits.findIndex((c) => shortHash(c) === reviewedHead);
  if (i >= 0) return i;
  const t = Date.parse(reviewedAt);
  return Math.max(1, timeline.pushes.filter((p) => Date.parse(p.at) > t).length);
}

// ---------------------------------------------------------------------------
// Queue ownership: whose "Waiting for Review" counts
// ---------------------------------------------------------------------------

/** One row of the Review Rota worksheet: who reviews a developer's PRs created in [from, to]. */
export interface RotaEntry {
  developer: string;
  reviewers: string[];
  /** YYYY-MM-DD, inclusive. */
  from: string;
  /** YYYY-MM-DD, inclusive; null = open-ended. */
  to: string | null;
}

export interface QueueOwnership {
  /** 'rota' when a rota row covers this PR, else 'engaged'. */
  mode: 'rota' | 'engaged';
  /** Reviewer ids whose position in the queue counts. */
  owners: Set<string>;
  /** Engaged mode and nobody has engaged yet: the PR has no owner. */
  unassigned: boolean;
  /** Rota reviewers who are not reviewers on the PR in Bitbucket. */
  rotaMissing: string[];
}

/**
 * The rota row for a PR: same developer (the PR author or the mapped Developer), PR created
 * within the row's dates. PRs created before any rota row starts fall back to engaged mode.
 */
export function findRota(rota: RotaEntry[], developers: string[], createdOn: string, timeZone: string): RotaEntry | undefined {
  const names = new Set(developers.map(normalizeName).filter(Boolean));
  const day = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(createdOn),
  );
  return rota.find((r) => names.has(normalizeName(r.developer)) && r.from <= day && (!r.to || day <= r.to));
}

/**
 * Who owns the review of a PR. Anyone who has engaged (approved, requested changes, commented)
 * always counts: their feedback has to be resolved. On top of that:
 *  - rota mode: the rota's reviewers own it, engaged or not.
 *  - engaged mode: nobody else. With ~10 default reviewers per PR, counting everyone would put
 *    every PR in everyone's queue.
 */
export function queueOwnership(input: {
  reviewers: Array<{ id: string; displayName: string; status: ReviewStatus | undefined }>;
  timeline: PrTimeline;
  rota: RotaEntry | undefined;
}): QueueOwnership {
  const { reviewers, timeline, rota } = input;
  const engaged = new Set([
    ...timeline.reviews.map((r) => r.reviewerId),
    ...(timeline.threads ?? []).map((t) => t.openedBy),
    ...reviewers.filter((r) => r.status === 'Approved' || r.status === 'Requested Changes').map((r) => r.id),
  ]);
  const owners = new Set(reviewers.filter((r) => engaged.has(r.id)).map((r) => r.id));
  if (!rota) return { mode: 'engaged', owners, unassigned: owners.size === 0, rotaMissing: [] };

  const onPr = new Map(reviewers.map((r) => [normalizeName(r.displayName), r.id]));
  const rotaMissing: string[] = [];
  for (const name of rota.reviewers) {
    const id = onPr.get(normalizeName(name));
    if (id) owners.add(id);
    else rotaMissing.push(name);
  }
  return { mode: 'rota', owners, unassigned: owners.size === 0, rotaMissing };
}

/**
 * Queue position of a reviewer who does not own the review. Closed and draft states apply to
 * everyone; otherwise they are Optional. On an unassigned PR one row (`carriesUnassigned`) says
 * "Waiting for Review / Unassigned", so the PR still shows up in the queue exactly once.
 */
export function nonOwnerQueue(q: ReviewerQueue, pr: BbPullRequest, carriesUnassigned: boolean): ReviewerQueue {
  const reviewStates: Array<QueueState | undefined> = ['Waiting for Review', 'Waiting for Re-review', 'Changes Requested'];
  if (!reviewStates.includes(q.state)) return q;
  if (carriesUnassigned) {
    return { state: 'Waiting for Review', waitingOn: 'Unassigned', waitingSince: pr.created_on, reviewRound: 1, commitsSinceReview: '' };
  }
  return { state: 'Optional', waitingOn: '', waitingSince: null, reviewRound: '', commitsSinceReview: '' };
}

// ---------------------------------------------------------------------------
// Whole-PR plan: L1 ownership, then the L2 step
// ---------------------------------------------------------------------------

export interface QueueReviewer {
  id: string;
  displayName: string;
  status: ReviewStatus | undefined;
  /** Level L2 in the Reviewer Levels worksheet. */
  l2: boolean;
}

export interface QueuePlan {
  byReviewer: Map<string, ReviewerQueue>;
  /** Where the PR as a whole is stuck (one value for all its rows); undefined if unknown. */
  prState: QueueState | undefined;
  mode: QueueOwnership['mode'];
  rotaMissing: string[];
}

/** Most urgent first: where a PR "is" when its reviewers are in different states. */
const PR_STATE_ORDER: QueueState[] = [
  'Waiting for Re-review',
  'Waiting for Review',
  'Changes Requested',
  'Waiting for L2',
  'Blocked by Dependency',
  'Approved',
];

/**
 * Queue position of every reviewer on a PR.
 *
 * L1: owners per `queueOwnership` (rota and/or engaged); everyone else is Optional.
 * L2: stays Optional until every L1 owner has approved, then "Waiting for L2" (each L2 reviewer
 * on their own row, so reviewer-load pivots count it for each of them) until one of them approves
 * or requests changes. That L2 reviewer is then treated like any owner, since the feedback has to
 * be resolved; the other L2 reviewers drop back to Optional. Comments alone don't pull an L2
 * reviewer in early.
 */
export function planQueue(input: {
  pr: BbPullRequest;
  timeline: PrTimeline;
  reviewers: QueueReviewer[];
  rota: RotaEntry | undefined;
  openDependencies: number[];
}): QueuePlan {
  const { pr, timeline, reviewers, rota, openDependencies } = input;
  const l1 = reviewers.filter((r) => !r.l2);
  const own = queueOwnership({ reviewers: l1, timeline, rota });
  const l1Owners = l1.filter((r) => own.owners.has(r.id));
  const l1Done = l1Owners.length > 0 && l1Owners.every((r) => r.status === 'Approved');
  const l1DoneAt = l1Done ? lastApprovalAt(timeline, l1Owners.map((r) => r.id)) ?? pr.updated_on : null;
  const carrier = own.unassigned ? (l1.length ? l1 : reviewers).map((r) => r.id).sort()[0] : undefined;
  const l2Acted = reviewers.some((r) => r.l2 && (r.status === 'Approved' || r.status === 'Requested Changes'));
  const reviewing = pr.state.trim().toUpperCase() === 'OPEN' && !pr.draft;

  const byReviewer = new Map<string, ReviewerQueue>();
  for (const r of reviewers) {
    const q = reviewerQueue({
      pr,
      timeline,
      reviewerId: r.id,
      reviewerName: r.displayName,
      status: r.status,
      openDependencies,
    });
    let result: ReviewerQueue;
    if (!r.l2) {
      result = own.owners.has(r.id) ? q : nonOwnerQueue(q, pr, r.id === carrier);
    } else if (r.status === 'Approved' || r.status === 'Requested Changes') {
      result = q;
    } else if (l1Done && reviewing && !l2Acted) {
      result = { ...q, state: 'Waiting for L2', waitingOn: r.displayName, waitingSince: l1DoneAt };
    } else {
      result = nonOwnerQueue(q, pr, r.id === carrier);
    }
    byReviewer.set(r.id, result);
  }

  return { byReviewer, prState: summarize(pr, [...byReviewer.values()]), mode: own.mode, rotaMissing: own.rotaMissing };
}

function summarize(pr: BbPullRequest, queues: ReviewerQueue[]): QueueState | undefined {
  const state = pr.state.trim().toUpperCase();
  if (CLOSED[state]) return CLOSED[state];
  if (state !== 'OPEN') return undefined;
  if (pr.draft) return 'Draft';
  const states = new Set(queues.map((q) => q.state));
  return PR_STATE_ORDER.find((s) => states.has(s));
}

function lastApprovalAt(timeline: PrTimeline, reviewerIds: string[]): string | undefined {
  const ids = new Set(reviewerIds);
  return [...timeline.reviews].reverse().find((r) => r.kind === 'approval' && ids.has(r.reviewerId))?.at;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/**
 * PRs this PR depends on, in priority order:
 *   1. the `Depends On` cell of the mapping worksheet ("#71, #72"; "-" or "none" = no dependency)
 *   2. "Depends on #71" in the PR description
 *   3. the target branch is another open PR's source branch (stacked PRs)
 * Sources 2 and 3 are combined; source 1 replaces both.
 */
export function resolveDependencies(
  pr: BbPullRequest,
  manual: string | undefined,
  openPrBySourceBranch: Map<string, number>,
): number[] {
  const override = manual?.trim();
  if (override) {
    if (/^(-|none|n\/a)$/i.test(override)) return [];
    return uniqueIds([...override.matchAll(/\d+/g)].map((m) => Number(m[0])), pr.id);
  }
  const fromDescription = parseDependsOn(pr.description ?? '');
  const target = pr.destination.branch?.name;
  const stackedOn = target ? openPrBySourceBranch.get(target) : undefined;
  return uniqueIds([...fromDescription, ...(stackedOn ? [stackedOn] : [])], pr.id);
}

/** "Depends on #71", "depends-on: #71, #72 and #80" → [71, 72, 80]. A bare number is not enough. */
export function parseDependsOn(text: string): number[] {
  const ids: number[] = [];
  for (const m of text.matchAll(/\bdepends[\s-]+on\b[\s:]*((?:#\d+(?:\s*(?:,|&|and)\s*)?)+)/gi)) {
    for (const n of m[1]!.matchAll(/#(\d+)/g)) ids.push(Number(n[1]));
  }
  return ids;
}

function uniqueIds(ids: number[], self: number): number[] {
  return [...new Set(ids)].filter((id) => Number.isInteger(id) && id > 0 && id !== self).sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/**
 * Working days (Mon–Fri) from `since` to `now`, by calendar date in `timeZone`: same day = 0,
 * Friday → Monday = 1. Matches an SLA written as "within 1 working day".
 */
export function workingDaysBetween(since: string, now: Date, timeZone: string): number {
  const from = localDate(new Date(since), timeZone);
  const to = localDate(now, timeZone);
  if (from === null || to === null || to <= from) return 0;
  let days = 0;
  for (let d = from + 86_400_000; d <= to; d += 86_400_000) {
    const dow = new Date(d).getUTCDay();
    if (dow !== 0 && dow !== 6) days++;
  }
  return days;
}

/** Midnight UTC of the calendar date `d` falls on in `timeZone`. */
function localDate(d: Date, timeZone: string): number | null {
  if (Number.isNaN(d.getTime())) return null;
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  return Date.parse(`${ymd}T00:00:00Z`);
}
