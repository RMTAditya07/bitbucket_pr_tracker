import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findCliqUser, type CliqUser } from '../src/cliq/client.js';
import { MAX_MESSAGE_LENGTH, dropLabel, fit, planDigests, workingDaysUntil, type DigestInput } from '../src/digest/plan.js';

const TODAY = '2026-09-29'; // Tuesday

function row(v: Record<string, string | number>): Record<string, unknown> {
  return {
    'PR Status': 'OPEN',
    Developer: 'Saad Khan',
    'Interactive Name': 'GEO_51319_1.html',
    'Build Drop Date': '1/10/2026',
    'Waiting On': '',
    'Days Waiting': '',
    'Review Round': '',
    'Commits Since Review': '',
    'Merged At': '',
    ...v,
  };
}

function plan(rows: Array<Record<string, unknown>>, extra: Partial<DigestInput> = {}) {
  const digests = planDigests({
    rows,
    rota: [],
    today: TODAY,
    kind: 'morning',
    prUrl: (id) => `https://bb/pr/${id}`,
    sheetUrl: 'https://sheet/x',
    ...extra,
  });
  return new Map(digests.map((d) => [d.person, d.text]));
}

describe('planDigests: author', () => {
  it('names the reviewer to connect with, never a pronoun', () => {
    const text = plan([
      row({ 'PR ID': '#145', Reviewer: 'Asha Rao', 'Queue State': 'Waiting for Review', 'PR Queue State': 'Waiting for Review', 'Waiting On': 'Asha Rao', 'Days Waiting': 2 }),
    ]).get('Saad Khan')!;
    assert.match(text, /\[#145\]\(https:\/\/bb\/pr\/145\) GEO_51319_1/);
    assert.match(text, /Please connect with Asha Rao \(2d\) to get it reviewed/);
    assert.doesNotMatch(text, /\b(he|she|him|her|his|them|they)\b/i);
  });

  it('asks the author to resolve comments and to chase re-reviews on the same PR', () => {
    const text = plan([
      row({ 'PR ID': '#77', Reviewer: 'Ravi', 'Queue State': 'Changes Requested', 'PR Queue State': 'Changes Requested', 'Waiting On': 'Saad Khan', 'Days Waiting': 1 }),
      row({ 'PR ID': '#77', Reviewer: 'Meena', 'Queue State': 'Waiting for Re-review', 'PR Queue State': 'Changes Requested', 'Waiting On': 'Meena', 'Days Waiting': 0 }),
    ]).get('Saad Khan')!;
    assert.match(text, /🔧 \[#77\]/);
    assert.match(text, /Ravi \(1d\) requested changes\. Resolve the comments and push the fixes/);
    assert.match(text, /Please follow up with Meena \(today\) for the re-review/);
  });

  it('points an unassigned PR at the rota reviewers', () => {
    const text = plan(
      [row({ 'PR ID': '#150', Reviewer: 'X', 'Queue State': 'Waiting for Review', 'PR Queue State': 'Waiting for Review', 'Waiting On': 'Unassigned', 'Days Waiting': 1 })],
      { rota: [{ developer: 'saad khan', reviewers: ['Asha Rao', 'Ravi'], from: '2026-09-01', to: null }] },
    );
    assert.match(text.get('Saad Khan')!, /Please connect with Asha Rao and Ravi from the review rota/);
    assert.match(text.get('Asha Rao')!, /🆕 Saad Khan · GEO_51319_1 · \[#150\]\([^)]*\) \(unassigned, on the rota\) 1d/);
  });

  it('covers L2, dependencies and ready-to-merge', () => {
    const text = plan([
      row({ 'PR ID': '#1', Reviewer: 'Stephen', 'Queue State': 'Waiting for L2', 'PR Queue State': 'Waiting for L2', 'Waiting On': 'Stephen', 'Days Waiting': 2 }),
      row({ 'PR ID': '#2', Reviewer: 'Asha', 'Queue State': 'Blocked by Dependency', 'PR Queue State': 'Blocked by Dependency', 'Waiting On': '#1' }),
      row({ 'PR ID': '#3', Reviewer: 'Asha', 'Queue State': 'Approved', 'PR Queue State': 'Approved' }),
    ]).get('Saad Khan')!;
    assert.match(text, /L1 approved\. Please connect with Stephen \(2d\) for the L2 review/);
    assert.match(text, /⛔ \[#2\].*\n.*Approved, waiting for #1 to merge first/);
    assert.match(text, /🔧 \[#3\].*\n.*All approvals in\. Ready to merge/);
  });

  it('skips closed PRs and optional reviewers', () => {
    const digests = plan([
      row({ 'PR ID': '#9', 'PR Status': 'MERGED', Reviewer: 'Asha', 'Queue State': 'Merged', 'PR Queue State': 'Merged' }),
      row({ 'PR ID': '#10', Reviewer: 'Ravi', 'Queue State': 'Optional', 'PR Queue State': 'Approved' }),
    ]);
    assert.equal(digests.has('Asha'), false);
    assert.equal(digests.has('Ravi'), false);
  });
});

describe('planDigests: reviewer', () => {
  it('splits fresh reviews and re-reviews, grouped by build drop, soonest first', () => {
    const text = plan([
      row({ 'PR ID': '#5', 'Build Drop Date': '9/10/2026', Reviewer: 'Asha', 'Queue State': 'Waiting for Review', 'Waiting On': 'Asha', 'Days Waiting': 4 }),
      row({ 'PR ID': '#6', Reviewer: 'Asha', 'Queue State': 'Waiting for Re-review', 'Waiting On': 'Asha', 'Days Waiting': 1, 'Review Round': 2, 'Commits Since Review': 3 }),
      row({ 'PR ID': '#7', 'Build Drop Date': '', 'Interactive Name': '', Reviewer: 'Asha', 'Queue State': 'Waiting for L2', 'Waiting On': 'Asha', 'Days Waiting': 0 }),
    ]).get('Asha')!;
    assert.match(text, /\*Reviews waiting on you\* \(3\)/);
    const order = ['#6', '#5', '#7'].map((id) => text.indexOf(`[${id}]`));
    assert.deepEqual([...order].sort((a, b) => a - b), order);
    assert.match(text, /🔁 Saad Khan · GEO_51319_1 · \[#6\]\([^)]*\) \+3 1d/);
    assert.match(text, /🆕 Saad Khan · \[#7\]\([^)]*\) L2 today/);
    assert.match(text, /No build drop date/);
  });

  it('never asks an author to review their own PR', () => {
    const digests = plan([row({ 'PR ID': '#8', Reviewer: 'Saad Khan', 'Queue State': 'Waiting for Review', 'Waiting On': 'Saad Khan' })]);
    assert.doesNotMatch(digests.get('Saad Khan') ?? '', /Reviews waiting on you/);
  });
});

describe('planDigests: evening', () => {
  it('lists PRs merged today', () => {
    const rows = [row({ 'PR ID': '#11', 'PR Status': 'MERGED', 'Merged At': '29/9/2026 10:15:00 AM', Reviewer: 'Asha', 'Queue State': 'Merged' })];
    assert.match(plan(rows, { kind: 'evening' }).get('Saad Khan')!, /🌙 \*End of day, Saad\.\*[\s\S]*Merged today:\* \[#11\]/);
    assert.equal(plan(rows).has('Saad Khan'), false);
  });
});

describe('drop labels', () => {
  it('counts working days and flags passed drops', () => {
    assert.equal(workingDaysUntil('2026-09-29', '2026-10-09'), 8);
    assert.equal(dropLabel('2026-09-29', TODAY), 'Build drop today, Tue 29 Sep');
    assert.equal(dropLabel('2026-10-01', TODAY), 'Build drop Thu 1 Oct, in 2 working days');
    assert.equal(dropLabel('2026-09-28', TODAY), '⚠️ Build drop was Mon 28 Sep, still open');
  });
});

describe('planDigests: grouping and length', () => {
  it('merges reviews of the same author and interactive into one line', () => {
    const text = plan([
      row({ 'PR ID': '#21', Reviewer: 'Asha', 'Queue State': 'Waiting for Re-review', 'Waiting On': 'Asha', 'Days Waiting': 1, 'Commits Since Review': 2 }),
      row({ 'PR ID': '#22', Reviewer: 'Asha', 'Queue State': 'Waiting for Re-review', 'Waiting On': 'Asha', 'Days Waiting': 3 }),
    ]).get('Asha')!;
    assert.match(text, /🔁 Saad Khan · GEO_51319_1 · \[#22\]\([^)]*\) 3d, \[#21\]\([^)]*\) \+2 1d/);
  });

  it('keeps one message: cuts the latest items and links the sheet', () => {
    const item = (n: number) => ({ kind: 'item' as const, prs: 2, text: `item ${n} ${'x'.repeat(1500)}` });
    const text = fit(
      [{ kind: 'fixed', prs: 0, text: 'head' }, { kind: 'heading', prs: 0, text: 'drop A' }, item(1), item(2), item(3), { kind: 'heading', prs: 0, text: 'drop B' }, item(4), item(5)],
      '\n\nlegend',
      'https://sheet/x',
    );
    assert.ok(text.length <= MAX_MESSAGE_LENGTH);
    assert.match(text, /item 3/);
    assert.doesNotMatch(text, /item 4|drop B/);
    assert.match(text, /…and 4 more PRs in the \[PR Reviews sheet\]\(https:\/\/sheet\/x\)\n\nlegend$/);
  });
});

describe('findCliqUser', () => {
  const users: CliqUser[] = [
    { id: '1', name: 'Shravya Das V D', email: 's@x' },
    { id: '2', name: 'Rithika S', email: 'r@x' },
    { id: '3', name: 'Rithika Srinivasan', email: 'rs@x' },
  ];
  it('matches exactly, then by a unique prefix', () => {
    assert.equal(findCliqUser(' rithika  s ', users)?.id, '2');
    assert.equal(findCliqUser('Shravya Das', users)?.id, '1');
  });
  it('uses CLIQ_USER_MAP emails first', () => {
    const map = new Map([['stephen prabhu', 'r@x']]);
    assert.equal(findCliqUser('Stephen  Prabhu', users, map)?.id, '2');
    assert.equal(findCliqUser('Stephen Prabhu', users), undefined);
  });
  it('refuses ambiguous or unknown names', () => {
    assert.equal(findCliqUser('Rithika', users), undefined);
    assert.equal(findCliqUser('Nobody', users), undefined);
  });
});
