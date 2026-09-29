import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CachingTimelines, parseActivity, parseThreads, timelineFingerprint } from '../src/bitbucket/timeline.js';
import type { BbPullRequest } from '../src/bitbucket/types.js';
import { toIsoDate } from '../src/zoho/sheet.js';
import {
  findRota,
  firstReviewAt,
  planQueue,
  queueOwnership,
  parseDependsOn,
  resolveDependencies,
  reviewerQueue,
  workingDaysBetween,
  type PrTimeline,
} from '../src/sync/queue.js';
import { AUTHOR, RITHIKA_S, SHRAVYA, makePr, participant } from './fixtures.js';

const A = 'aaaaaaaaaaaa';
const B = 'bbbbbbbbbbbb';
const C = 'cccccccccccc';
const SHRAVYA_ID = '{22222222-bbbb}';

function pr(overrides: Partial<BbPullRequest> = {}): BbPullRequest {
  return makePr({ id: 70, source: { branch: { name: 'feature/pr-70' }, commit: { hash: B } }, ...overrides });
}

/** Created on A, Shravya requested changes on A, author pushed B. */
const TIMELINE: PrTimeline = {
  pushes: [
    { hash: A, at: '2026-09-01T10:00:00Z' },
    { hash: B, at: '2026-09-22T08:00:00Z' },
  ],
  reviews: [
    { reviewerId: SHRAVYA_ID, kind: 'comment', at: '2026-09-21T08:55:00Z' },
    { reviewerId: SHRAVYA_ID, kind: 'changes_requested', at: '2026-09-21T09:00:00Z' },
  ],
  mergedAt: null,
  commits: [B, 'b2b2b2b2b2b2', A],
  threads: [],
};

/** Shravya requested changes on A with two threads; the author has not pushed. */
const NO_PUSH: PrTimeline = { ...TIMELINE, pushes: TIMELINE.pushes.slice(0, 1) };
const thread = (resolvedAt: string | null, openedBy = SHRAVYA_ID) => ({ openedBy, openedAt: '2026-09-21T08:55:00Z', resolvedAt });

const queueFor = (p: BbPullRequest, timeline: PrTimeline, status: Parameters<typeof reviewerQueue>[0]['status'], openDependencies: number[] = []) =>
  reviewerQueue({ pr: p, timeline, reviewerId: SHRAVYA_ID, reviewerName: 'Shravya', status, openDependencies });

describe('reviewerQueue', () => {
  it('push after a change request → Waiting for Re-review, on the reviewer', () => {
    const q = queueFor(pr(), TIMELINE, 'Requested Changes');
    assert.deepEqual(q, {
      state: 'Waiting for Re-review',
      waitingOn: 'Shravya',
      waitingSince: '2026-09-22T08:00:00Z',
      reviewRound: 2,
      commitsSinceReview: 2,
    });
  });

  it('change request with no push since → Changes Requested, on the author', () => {
    const q = queueFor(pr({ source: { commit: { hash: A } } }), { ...TIMELINE, pushes: TIMELINE.pushes.slice(0, 1) }, 'Requested Changes');
    assert.equal(q.state, 'Changes Requested');
    assert.equal(q.waitingOn, AUTHOR.display_name);
    assert.equal(q.waitingSince, '2026-09-21T09:00:00Z');
    assert.equal(q.reviewRound, 1);
    assert.equal(q.commitsSinceReview, 0);
  });

  it('Bitbucket reset the request on push (status Pending) → still a re-review', () => {
    assert.equal(queueFor(pr(), TIMELINE, 'Pending').state, 'Waiting for Re-review');
  });

  it('comments then a push count as a review round, without a formal request', () => {
    const timeline = { ...TIMELINE, reviews: TIMELINE.reviews.slice(0, 1) };
    assert.equal(queueFor(pr(), timeline, 'Pending').state, 'Waiting for Re-review');
  });

  it('never reviewed → Waiting for Review since the PR was created, round 1', () => {
    const q = queueFor(pr(), { ...TIMELINE, reviews: [] }, 'Pending');
    assert.deepEqual(q, {
      state: 'Waiting for Review',
      waitingOn: 'Shravya',
      waitingSince: pr().created_on,
      reviewRound: 1,
      commitsSinceReview: '',
    });
  });

  it('approved → Approved, or Blocked by Dependency while a dependency is open', () => {
    const timeline = { ...TIMELINE, reviews: [...TIMELINE.reviews, { reviewerId: SHRAVYA_ID, kind: 'approval' as const, at: '2026-09-22T12:00:00Z' }] };
    assert.equal(queueFor(pr(), timeline, 'Approved').state, 'Approved');
    const blocked = queueFor(pr(), timeline, 'Approved', [68, 71]);
    assert.equal(blocked.state, 'Blocked by Dependency');
    assert.equal(blocked.waitingOn, '#68, #71');
    assert.equal(blocked.waitingSince, '2026-09-22T12:00:00Z');
  });

  it('dependencies do not block review itself', () => {
    assert.equal(queueFor(pr(), TIMELINE, 'Requested Changes', [68]).state, 'Waiting for Re-review');
  });

  it('draft → Draft, on the author', () => {
    const q = queueFor(pr({ draft: true }), TIMELINE, 'Pending');
    assert.equal(q.state, 'Draft');
    assert.equal(q.waitingOn, AUTHOR.display_name);
  });

  it('closed PRs leave the queue', () => {
    const q = queueFor(pr({ state: 'MERGED' }), TIMELINE, 'Approved');
    assert.deepEqual(q, { state: 'Merged', waitingOn: '', waitingSince: null, reviewRound: '', commitsSinceReview: '' });
  });

  it('after a rebase the reviewed commit is gone: counts pushes instead', () => {
    const rebased = { ...TIMELINE, pushes: [...TIMELINE.pushes, { hash: C, at: '2026-09-22T09:00:00Z' }], commits: [C, 'c1c1c1c1c1c1'] };
    const q = queueFor(pr({ source: { commit: { hash: C } } }), rebased, 'Pending');
    assert.equal(q.commitsSinceReview, 2);
    assert.equal(q.reviewRound, 2);
  });
});

describe('reviewerQueue: handing feedback back by resolving threads', () => {
  const onA = pr({ source: { commit: { hash: A } } });

  it('all of the reviewer’s threads resolved after the request → Waiting for Re-review', () => {
    const q = queueFor(onA, { ...NO_PUSH, threads: [thread('2026-09-22T10:00:00Z'), thread('2026-09-22T11:00:00Z')] }, 'Requested Changes');
    assert.deepEqual(q, {
      state: 'Waiting for Re-review',
      waitingOn: 'Shravya',
      waitingSince: '2026-09-22T11:00:00Z',
      reviewRound: 2,
      commitsSinceReview: 0,
    });
  });

  it('one thread still open → stays with the author', () => {
    const q = queueFor(onA, { ...NO_PUSH, threads: [thread('2026-09-22T10:00:00Z'), thread(null)] }, 'Requested Changes');
    assert.equal(q.state, 'Changes Requested');
  });

  it('threads resolved before the latest change request do not count', () => {
    const q = queueFor(onA, { ...NO_PUSH, threads: [thread('2026-09-21T08:58:00Z')] }, 'Requested Changes');
    assert.equal(q.state, 'Changes Requested');
  });

  it('only this reviewer’s threads matter, and a request without threads needs a push', () => {
    const others = { ...NO_PUSH, threads: [thread('2026-09-22T10:00:00Z', '{11111111-aaaa}')] };
    assert.equal(queueFor(onA, others, 'Requested Changes').state, 'Changes Requested');
  });
});

describe('findRota', () => {
  const rota = [
    { developer: 'Saad Khan', reviewers: ['Shravya Das'], from: '2026-09-30', to: '2026-10-13' },
    { developer: 'saad  khan', reviewers: ['Rakesh S'], from: '2026-10-14', to: null },
  ];
  it('matches the developer by name and the PR creation date (in the sheet time zone)', () => {
    assert.equal(findRota(rota, ['Saad Khan'], '2026-09-29T12:00:00Z', 'UTC'), undefined, 'before the rota: engaged mode');
    assert.equal(findRota(rota, ['Saad Khan'], '2026-09-29T20:00:00Z', 'Asia/Kolkata')?.reviewers[0], 'Shravya Das', '30 Sep in India');
    assert.equal(findRota(rota, ['', 'Saad Khan'], '2026-10-13T10:00:00Z', 'UTC')?.reviewers[0], 'Shravya Das');
    assert.equal(findRota(rota, ['Saad Khan'], '2027-01-01T00:00:00Z', 'UTC')?.reviewers[0], 'Rakesh S', 'open-ended');
    assert.equal(findRota(rota, ['Rakesh S'], '2026-10-01T00:00:00Z', 'UTC'), undefined);
  });
});

describe('queueOwnership', () => {
  const reviewers = [
    { id: SHRAVYA_ID, displayName: 'Shravya', status: 'Pending' as const },
    { id: '{11111111-aaaa}', displayName: 'Rithika S', status: 'Pending' as const },
    { id: '{33333333-cccc}', displayName: 'Arjun', status: 'Approved' as const },
  ];
  const quiet = { ...TIMELINE, reviews: [], threads: [] };

  it('engaged mode: anyone who reviewed, commented, opened a thread or approved', () => {
    const o = queueOwnership({ reviewers, timeline: { ...quiet, threads: [thread(null, '{11111111-aaaa}')] }, rota: undefined });
    assert.deepEqual([...o.owners].sort(), ['{11111111-aaaa}', '{33333333-cccc}']);
    assert.equal(o.unassigned, false);
    const none = queueOwnership({ reviewers: reviewers.slice(0, 2), timeline: quiet, rota: undefined });
    assert.equal(none.unassigned, true);
  });

  it('rota mode: rota reviewers by name, plus engaged; reports rota names not on the PR', () => {
    const o = queueOwnership({
      reviewers,
      timeline: quiet,
      rota: { developer: 'x', reviewers: ['shravya ', 'Karthik'], from: '2026-01-01', to: null },
    });
    assert.equal(o.mode, 'rota');
    assert.deepEqual([...o.owners].sort(), [SHRAVYA_ID, '{33333333-cccc}']);
    assert.deepEqual(o.rotaMissing, ['Karthik']);
  });
});

describe('planQueue: L2 step', () => {
  const RITHIKA = '{11111111-aaaa}';
  const MUTHU = '{mmmm}';
  const STEPHEN = '{ssss}';
  const onA = pr({ source: { commit: { hash: A } } });
  const base: PrTimeline = { pushes: [{ hash: A, at: '2026-09-01T10:00:00Z' }], reviews: [], mergedAt: null, commits: [A], threads: [] };
  const approve = (reviewerId: string, at: string) => ({ reviewerId, kind: 'approval' as const, at });
  const people = (shravya: string, rithika: string, muthu = 'Pending', stephen = 'Pending') => [
    { id: SHRAVYA_ID, displayName: 'Shravya', status: shravya as any, l2: false },
    { id: RITHIKA, displayName: 'Rithika S', status: rithika as any, l2: false },
    { id: MUTHU, displayName: 'Muthu', status: muthu as any, l2: true },
    { id: STEPHEN, displayName: 'Stephen', status: stephen as any, l2: true },
  ];
  const rota = { developer: 'Rithika M', reviewers: ['Shravya', 'Rithika S'], from: '2026-01-01', to: null };
  const states = (p: ReturnType<typeof planQueue>) => [...p.byReviewer.values()].map((q) => [q.state, q.waitingOn]);

  it('L2 stays Optional until every L1 owner approves, even after commenting', () => {
    const timeline = { ...base, reviews: [approve(SHRAVYA_ID, '2026-09-02T10:00:00Z'), { reviewerId: MUTHU, kind: 'comment' as const, at: '2026-09-02T11:00:00Z' }] };
    const p = planQueue({ pr: onA, timeline, reviewers: people('Approved', 'Pending'), rota, openDependencies: [] });
    assert.deepEqual(states(p), [
      ['Approved', ''],
      ['Waiting for Review', 'Rithika S'],
      ['Optional', ''],
      ['Optional', ''],
    ]);
    assert.equal(p.prState, 'Waiting for Review');
  });

  it('all L1 owners approved → each L2 reviewer is Waiting for L2, since the last L1 approval', () => {
    const timeline = { ...base, reviews: [approve(SHRAVYA_ID, '2026-09-02T10:00:00Z'), approve(RITHIKA, '2026-09-03T09:00:00Z')] };
    const p = planQueue({ pr: onA, timeline, reviewers: people('Approved', 'Approved'), rota, openDependencies: [71] });
    assert.deepEqual(states(p), [
      ['Blocked by Dependency', '#71'],
      ['Blocked by Dependency', '#71'],
      ['Waiting for L2', 'Muthu'],
      ['Waiting for L2', 'Stephen'],
    ]);
    assert.equal(p.byReviewer.get(MUTHU)!.waitingSince, '2026-09-03T09:00:00Z');
    assert.equal(p.prState, 'Waiting for L2', 'a dependency blocks merging, not the L2 review');
  });

  it('an L2 change request goes back to the author; an L2 approval ends the step', () => {
    const timeline = { ...base, reviews: [approve(SHRAVYA_ID, '2026-09-02T10:00:00Z'), approve(RITHIKA, '2026-09-03T09:00:00Z'), { reviewerId: STEPHEN, kind: 'changes_requested' as const, at: '2026-09-04T09:00:00Z' }] };
    const p = planQueue({ pr: onA, timeline, reviewers: people('Approved', 'Approved', 'Pending', 'Requested Changes'), rota, openDependencies: [] });
    assert.deepEqual(p.byReviewer.get(STEPHEN)!.state, 'Changes Requested');
    assert.equal(p.prState, 'Changes Requested');

    const done = planQueue({ pr: onA, timeline: { ...base, reviews: [...timeline.reviews.slice(0, 2), approve(STEPHEN, '2026-09-04T09:00:00Z')] }, reviewers: people('Approved', 'Approved', 'Pending', 'Approved'), rota, openDependencies: [] });
    assert.equal(done.prState, 'Approved');
    assert.equal(done.byReviewer.get(MUTHU)!.state, 'Optional', 'one L2 approval is enough; the other drops out');
    assert.equal(p.byReviewer.get(MUTHU)!.state, 'Optional', 'likewise after an L2 change request');
  });

  it('engaged mode: one engaged L1 approving is enough; an untouched PR is Unassigned on an L1 row', () => {
    const one = planQueue({ pr: onA, timeline: { ...base, reviews: [approve(RITHIKA, '2026-09-03T09:00:00Z')] }, reviewers: people('Pending', 'Approved'), rota: undefined, openDependencies: [] });
    assert.equal(one.byReviewer.get(SHRAVYA_ID)!.state, 'Optional');
    assert.equal(one.prState, 'Waiting for L2');

    const none = planQueue({ pr: onA, timeline: base, reviewers: people('Pending', 'Pending'), rota: undefined, openDependencies: [] });
    assert.deepEqual(states(none).filter(([s]) => s !== 'Optional'), [['Waiting for Review', 'Unassigned']]);
    assert.equal(none.byReviewer.get(RITHIKA)!.waitingOn, 'Unassigned', 'lowest L1 id carries it, never an L2');
  });

  it('closed and draft PRs', () => {
    assert.equal(planQueue({ pr: pr({ state: 'MERGED' }), timeline: base, reviewers: people('Approved', 'Approved'), rota, openDependencies: [] }).prState, 'Merged');
    const draft = planQueue({ pr: pr({ draft: true }), timeline: base, reviewers: people('Approved', 'Approved'), rota, openDependencies: [] });
    assert.equal(draft.prState, 'Draft');
    assert.equal(draft.byReviewer.get(MUTHU)!.state, 'Draft', 'no L2 step on drafts; every row says Draft');
  });
});

describe('toIsoDate (rota From / To cells)', () => {
  it('reads ISO and day-first dates', () => {
    assert.equal(toIsoDate('2026-09-30'), '2026-09-30');
    assert.equal(toIsoDate('30/09/2026'), '2026-09-30');
    assert.equal(toIsoDate('01/10/2026'), '2026-10-01', 'ambiguous: day-first');
    assert.equal(toIsoDate(''), null);
  });
});

describe('firstReviewAt', () => {
  it('ignores the author’s own comments', () => {
    const timeline = { ...TIMELINE, reviews: [{ reviewerId: '{99999999-dddd}', kind: 'comment' as const, at: '2026-09-02T00:00:00Z' }, ...TIMELINE.reviews] };
    assert.equal(firstReviewAt(pr(), timeline), '2026-09-21T08:55:00Z');
    assert.equal(firstReviewAt(pr(), { ...TIMELINE, reviews: [] }), null);
  });
});

describe('parseActivity', () => {
  it('extracts pushes, reviews and merge time, oldest first', () => {
    const t = parseActivity([
      { update: { state: 'MERGED', date: '2026-09-24T10:00:00Z', source: { commit: { hash: `${B}ffff` } } } },
      { approval: { date: '2026-09-23T10:00:00Z', user: SHRAVYA } },
      { update: { state: 'OPEN', date: '2026-09-22T08:00:00Z', source: { commit: { hash: B } } } },
      { comment: { created_on: '2026-09-21T11:00:00Z', user: RITHIKA_S, deleted: true } },
      { changes_requested: { date: '2026-09-21T09:00:00Z', user: SHRAVYA } },
      { update: { state: 'OPEN', date: '2026-09-02T00:00:00Z', source: { commit: { hash: A } } } }, // title edit
      { update: { state: 'OPEN', date: '2026-09-01T10:00:00Z', source: { commit: { hash: A } } } },
    ]);
    assert.deepEqual(t.pushes, [
      { hash: A, at: '2026-09-01T10:00:00Z' },
      { hash: B, at: '2026-09-22T08:00:00Z' },
    ]);
    assert.deepEqual(
      t.reviews.map((r) => [r.reviewerId, r.kind]),
      [
        [SHRAVYA_ID, 'changes_requested'],
        [SHRAVYA_ID, 'approval'],
      ],
    );
    assert.equal(t.mergedAt, '2026-09-24T10:00:00Z');
  });
});

describe('parseThreads', () => {
  it('keeps published top-level comments with their resolution time', () => {
    const threads = parseThreads([
      { id: 1, created_on: '2026-09-21T08:55:00Z', user: SHRAVYA, resolution: { created_on: '2026-09-22T10:00:00Z' } },
      { id: 2, created_on: '2026-09-21T09:10:00Z', user: SHRAVYA, parent: { id: 1 } },
      { id: 3, created_on: '2026-09-21T09:20:00Z', user: SHRAVYA, deleted: true },
      { id: 4, created_on: '2026-09-21T09:30:00Z', user: SHRAVYA, pending: true },
      { id: 5, created_on: '2026-09-21T09:40:00Z', user: RITHIKA_S, resolution: null },
      { id: 6, created_on: '2026-09-21T09:50:00Z', updated_on: '2026-09-23T07:00:00Z', user: RITHIKA_S, resolution: {} },
    ]);
    assert.deepEqual(threads, [
      { openedBy: SHRAVYA_ID, openedAt: '2026-09-21T08:55:00Z', resolvedAt: '2026-09-22T10:00:00Z' },
      { openedBy: '{11111111-aaaa}', openedAt: '2026-09-21T09:40:00Z', resolvedAt: null },
      { openedBy: '{11111111-aaaa}', openedAt: '2026-09-21T09:50:00Z', resolvedAt: '2026-09-23T07:00:00Z' },
    ]);
  });
});

describe('dependencies', () => {
  it('parses "depends on #N" lists and ignores bare numbers', () => {
    assert.deepEqual(parseDependsOn('Depends on #71'), [71]);
    assert.deepEqual(parseDependsOn('depends-on: #71, #72 and #80\nunrelated #99'), [71, 72, 80]);
    assert.deepEqual(parseDependsOn('depends on 3 other things'), []);
  });

  it('combines description and stacked branch; the mapping override replaces both', () => {
    const p = pr({ description: 'Depends on #68', destination: { branch: { name: 'feature/pr-71' } } });
    const open = new Map([['feature/pr-71', 71]]);
    assert.deepEqual(resolveDependencies(p, undefined, open), [68, 71]);
    assert.deepEqual(resolveDependencies(p, '', open), [68, 71]);
    assert.deepEqual(resolveDependencies(p, '#90, 91', open), [90, 91]);
    assert.deepEqual(resolveDependencies(p, '-', open), []);
    assert.deepEqual(resolveDependencies(p, '#70', open), [], 'never depends on itself');
  });
});

describe('workingDaysBetween', () => {
  it('counts weekdays by calendar date in the sheet time zone', () => {
    const wed = new Date('2026-09-23T06:00:00Z');
    assert.equal(workingDaysBetween('2026-09-23T01:00:00Z', wed, 'UTC'), 0);
    assert.equal(workingDaysBetween('2026-09-22T23:00:00Z', wed, 'UTC'), 1);
    assert.equal(workingDaysBetween('2026-09-18T12:00:00Z', new Date('2026-09-21T09:00:00Z'), 'UTC'), 1, 'Fri → Mon');
    assert.equal(workingDaysBetween('2026-09-19T12:00:00Z', new Date('2026-09-20T09:00:00Z'), 'UTC'), 0, 'weekend');
    // 22 Sep 20:00 UTC is already 23 Sep in India.
    assert.equal(workingDaysBetween('2026-09-22T20:00:00Z', wed, 'Asia/Kolkata'), 0);
  });
});

describe('CachingTimelines', () => {
  it('re-fetches only when the PR head, state or a participant changes', async () => {
    let calls = 0;
    const inner = { get: async () => (calls++, TIMELINE) };
    const base = pr({ participants: [participant(SHRAVYA, 'changes_requested')] });

    const first = new CachingTimelines(inner);
    await first.get(base);
    const second = new CachingTimelines(inner, first.entries());
    await second.get(base);
    assert.equal(calls, 1);
    assert.equal(second.fetched, 0);

    await second.get({ ...base, participants: [{ ...participant(SHRAVYA, 'approved'), participated_on: '2026-09-23T00:00:00Z' }] });
    await new CachingTimelines(inner, second.entries()).get({ ...base, source: { commit: { hash: C } } });
    assert.equal(calls, 3);
  });

  it('refreshes only the threads of an unchanged PR with a change request outstanding', async () => {
    let full = 0;
    let threads = 0;
    const inner = {
      get: async () => (full++, TIMELINE),
      threads: async () => (threads++, [thread('2026-09-22T10:00:00Z')]),
    };
    const requested = pr({ id: 70, participants: [participant(SHRAVYA, 'changes_requested')] });
    const approved = pr({ id: 71, participants: [participant(SHRAVYA, 'approved')] });

    const first = new CachingTimelines(inner);
    await first.get(requested);
    await first.get(approved);
    assert.equal(full, 2);

    const second = new CachingTimelines(inner, first.entries());
    const t = await second.get(requested);
    await second.get(approved);
    assert.equal(full, 2, 'no full re-fetch for unchanged PRs');
    assert.equal(threads, 1, 'threads refreshed only where changes are requested');
    assert.equal(t.threads[0]!.resolvedAt, '2026-09-22T10:00:00Z');
    assert.equal(second.entries()['70']!.timeline.threads.length, 1, 'refreshed threads are cached');
  });

  it('re-fetches cache entries written before threads existed', async () => {
    let full = 0;
    const inner = { get: async () => (full++, TIMELINE) };
    const base = pr();
    const { threads: _, ...old } = TIMELINE;
    const c = new CachingTimelines(inner, { '70': { fingerprint: timelineFingerprint(base), timeline: old as PrTimeline } });
    await c.get(base);
    assert.equal(full, 1);
  });
});
