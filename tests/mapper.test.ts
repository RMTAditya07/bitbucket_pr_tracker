import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractReviewers } from '../src/bitbucket/reviewers.js';
import {
  COL,
  MANUAL_COLUMNS,
  buildSyncedFields,
  cellEquals,
  daysOpen,
  diffSyncedFields,
  fillBlankManualFields,
  formatDateTime,
  normalizePrState,
  normalizeReviewState,
  resolveManualFields,
} from '../src/sync/mapper.js';
import { ARJUN, AUTHOR, RITHIKA_S, SHRAVYA, makePr, participant } from './fixtures.js';

describe('normalizeReviewState', () => {
  it('maps Bitbucket participant states', () => {
    assert.equal(normalizeReviewState('approved').status, 'Approved');
    assert.equal(normalizeReviewState('changes_requested').status, 'Requested Changes');
    assert.equal(normalizeReviewState(null).status, 'Pending');
    assert.equal(normalizeReviewState(undefined).status, 'Pending');
  });
  it('falls back to the approved flag when state is absent', () => {
    assert.equal(normalizeReviewState(null, true).status, 'Approved');
  });
  it('does not invent a status for unknown states, but keeps the raw value', () => {
    const r = normalizeReviewState('needs_work');
    assert.equal(r.status, undefined);
    assert.equal(r.raw, 'needs_work');
  });
});

describe('normalizePrState', () => {
  it('maps the four Bitbucket states', () => {
    for (const s of ['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED']) assert.equal(normalizePrState(s).status, s);
    assert.equal(normalizePrState('merged').status, 'MERGED');
  });
  it('preserves unknown states as raw only', () => {
    assert.deepEqual(normalizePrState('DRAFT'), { status: undefined, raw: 'DRAFT' });
  });
});

describe('extractReviewers', () => {
  it('produces one entry per reviewer with their state', () => {
    const pr = makePr({
      id: 123,
      reviewers: [RITHIKA_S, SHRAVYA],
      participants: [participant(RITHIKA_S, 'approved'), participant(SHRAVYA, 'changes_requested')],
    });
    const { reviewers } = extractReviewers(pr);
    assert.deepEqual(
      reviewers.map((r) => [r.displayName, r.status]),
      [
        ['Rithika S', 'Approved'],
        ['Shravya', 'Requested Changes'],
      ],
    );
  });
  it('treats assigned reviewers who have not acted as Pending', () => {
    const pr = makePr({ id: 1, reviewers: [ARJUN], participants: [] });
    assert.equal(extractReviewers(pr).reviewers[0]!.status, 'Pending');
  });
  it('includes non-assigned participants who approved, excludes commenters', () => {
    const pr = makePr({
      id: 1,
      reviewers: [],
      participants: [participant(ARJUN, 'approved', 'PARTICIPANT'), participant(AUTHOR, null, 'PARTICIPANT')],
    });
    assert.deepEqual(
      extractReviewers(pr).reviewers.map((r) => r.displayName),
      ['Arjun'],
    );
  });
  it('never duplicates a reviewer present in both lists', () => {
    const pr = makePr({ id: 1, reviewers: [SHRAVYA], participants: [participant(SHRAVYA, 'approved')] });
    assert.equal(extractReviewers(pr).reviewers.length, 1);
  });
  it('skips accounts with no stable identity instead of guessing', () => {
    const pr = makePr({ id: 1, reviewers: [{ display_name: 'Ghost' }] });
    const out = extractReviewers(pr);
    assert.equal(out.reviewers.length, 0);
    assert.deepEqual(out.skipped, ['Ghost']);
  });
});

describe('formatDateTime', () => {
  it('formats Bitbucket timestamps in the configured zone', () => {
    assert.equal(formatDateTime('2026-09-20T12:30:00.123456+00:00', 'UTC'), '2026-09-20 12:30:00');
    assert.equal(formatDateTime('2026-09-20T12:30:00+00:00', 'Asia/Kolkata'), '2026-09-20 18:00:00');
  });
  it('returns empty string for invalid input', () => {
    assert.equal(formatDateTime('not a date', 'UTC'), '');
  });
});

describe('buildSyncedFields', () => {
  const pr = makePr({ id: 123, state: 'OPEN' });
  const reviewer = { id: '{a}', displayName: 'Shravya', rawState: 'approved', status: 'Approved' as const };

  it('fills every Bitbucket-owned column and no manual column', () => {
    const f = buildSyncedFields(pr, reviewer, 'L1', 'UTC');
    assert.deepEqual(f[COL.prId], { url: 'https://bitbucket.org/ws/repo/pull-requests/123', text: '#123' });
    assert.equal(f[COL.reviewer], 'Shravya');
    assert.equal(f[COL.reviewerLevel], 'L1');
    assert.equal(f[COL.reviewStatus], 'Approved');
    assert.equal(f[COL.prStatus], 'OPEN');
    assert.equal(f[COL.sourceBranch], 'feature/pr-123');
    assert.equal(f[COL.targetBranch], 'develop');
    for (const col of MANUAL_COLUMNS) assert.ok(!(col in f), `${col} must not be synced`);
  });
  it('omits values it cannot determine, so existing cells are preserved', () => {
    const f = buildSyncedFields(makePr({ id: 1, state: 'WEIRD' }), { ...reviewer, status: undefined }, undefined, 'UTC');
    assert.ok(!(COL.reviewerLevel in f));
    assert.ok(!(COL.reviewStatus in f));
    assert.ok(!(COL.prStatus in f));
  });
});

describe('diffSyncedFields / cellEquals', () => {
  it('reports only changed columns', () => {
    const existing = { [COL.prId]: 123, [COL.reviewStatus]: 'Pending', [COL.prStatus]: 'OPEN' };
    const desired = { [COL.prId]: 123, [COL.reviewStatus]: 'Approved', [COL.prStatus]: 'OPEN' };
    assert.deepEqual(diffSyncedFields(existing, desired), { [COL.reviewStatus]: 'Approved' });
  });
  it('never reports manual columns even if present in the desired values', () => {
    const diff = diffSyncedFields({ [COL.developer]: 'Rithika M' }, { [COL.developer]: 'Someone else' });
    assert.deepEqual(diff, {});
  });
  it('treats "123" and 123 as equal', () => {
    assert.ok(cellEquals(COL.prId, '123', 123));
    assert.ok(cellEquals(COL.prId, 123, 123));
  });
  it('treats equivalent date formats as equal (to the minute)', () => {
    assert.ok(cellEquals(COL.updatedAt, '2026-09-20 12:30', '2026-09-20 12:30:00'));
    assert.ok(cellEquals(COL.updatedAt, '2026/09/20 12:30:59', '2026-09-20 12:30:00'));
    assert.ok(!cellEquals(COL.updatedAt, '2026-09-20 12:31:00', '2026-09-20 12:30:00'));
  });
  it('treats empty and missing as equal to empty string', () => {
    assert.ok(cellEquals(COL.sourceBranch, undefined, ''));
    assert.ok(cellEquals(COL.sourceBranch, null, ''));
  });
});

describe('resolveManualFields', () => {
  const mapping = {
    prId: 123,
    interactiveName: 'WNO_storyAnimations',
    developer: 'Rithika M',
    interactiveType: 'Static',
    phase: 'SPEC',
    prLabel: 'PR1',
  };

  it('uses the mapping worksheet first', () => {
    assert.deepEqual(resolveManualFields(mapping, [{ [COL.interactiveName]: 'Other' }]), {
      [COL.developer]: 'Rithika M',
      [COL.interactiveType]: 'Static',
      [COL.interactiveName]: 'WNO_storyAnimations',
      [COL.phase]: 'SPEC',
      [COL.pr]: 'PR1',
    });
  });
  it('falls back to an existing sheet row for the same PR', () => {
    const sibling = {
      [COL.developer]: 'Rithika M',
      [COL.interactiveType]: 'Static',
      [COL.interactiveName]: 'WNO_storyAnimations',
      [COL.phase]: 'SPEC',
      [COL.pr]: 'PR1',
      [COL.reviewer]: 'Shravya',
    };
    const out = resolveManualFields(undefined, [{ [COL.interactiveName]: '' }, sibling]);
    assert.equal(out?.[COL.interactiveName], 'WNO_storyAnimations');
    assert.ok(!(COL.reviewer in out!));
  });
  it('returns null (unmapped) rather than guessing', () => {
    assert.equal(resolveManualFields(undefined, []), null);
    assert.equal(resolveManualFields({ ...mapping, interactiveName: '  ' }, []), null);
  });
});

describe('fillBlankManualFields', () => {
  it('only fills cells that are blank, never overwrites', () => {
    const existing = { [COL.developer]: 'Typed', [COL.phase]: '  ', [COL.interactiveName]: null };
    const manual = { [COL.developer]: 'Mapped', [COL.phase]: 'SPEC', [COL.interactiveName]: 'X', [COL.pr]: '' };
    assert.deepEqual(fillBlankManualFields(existing, manual), { [COL.phase]: 'SPEC', [COL.interactiveName]: 'X' });
  });
});

describe('PR ID hyperlink', () => {
  const link = { url: 'https://bitbucket.org/ws/repo/pull-requests/123', text: '#123' };
  it('equals what Zoho reads back (the text only)', () => {
    assert.ok(cellEquals(COL.prId, '#123', link));
  });
  it('differs from a legacy plain-number cell, so old rows are converted once', () => {
    assert.ok(!cellEquals(COL.prId, 123, link));
    assert.ok(!cellEquals(COL.prId, '123', link));
  });
});

describe('Zoho locale dates', () => {
  it('matches what Zoho (India locale) reads back: D/M/YYYY h:mm:ss AM/PM', () => {
    assert.ok(cellEquals(COL.createdAt, '6/9/2026 5:51:45 PM', '2026-09-06 17:51:45'));
    assert.ok(cellEquals(COL.updatedAt, '23/9/2026 11:31:20 AM', '2026-09-23 11:31:20'));
    assert.ok(cellEquals(COL.updatedAt, '7/9/2026 12:05:00 AM', '2026-09-07 00:05:00'));
  });
  it('tolerates Zoho float rounding, including across a minute boundary', () => {
    assert.ok(cellEquals(COL.createdAt, '7/9/2026 5:02:55.999 AM', '2026-09-07 05:02:56'));
    assert.ok(cellEquals(COL.updatedAt, '23/9/2026 10:02:59.999 AM', '2026-09-23 10:03:00'));
    assert.ok(cellEquals(COL.updatedAt, '23/9/2026 12:24:49.999 PM', '2026-09-23 12:24:50'));
  });
  it('still detects a real change', () => {
    assert.ok(!cellEquals(COL.updatedAt, '7/9/2026 1:35:33 PM', '2026-09-08 13:35:33'));
    assert.ok(!cellEquals(COL.updatedAt, '7/9/2026 1:35:33 PM', '2026-09-07 14:35:33'));
  });
});

describe('daysOpen', () => {
  const now = new Date('2026-09-23T12:00:00Z');
  it('counts to now for open PRs', () => {
    assert.equal(daysOpen({ state: 'OPEN', created_on: '2026-09-20T10:00:00Z', updated_on: '2026-09-21T00:00:00Z' }, now), 3);
  });
  it('counts to the last update for closed PRs', () => {
    assert.equal(daysOpen({ state: 'MERGED', created_on: '2026-09-01T10:00:00Z', updated_on: '2026-09-06T09:00:00Z' }, now), 4);
  });
});
