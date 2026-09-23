import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import type { BbPullRequest } from '../src/bitbucket/types.js';
import { AuthError } from '../src/http/request.js';
import { silentLogger, type LogFields, type Logger } from '../src/logger/logger.js';
import type { InteractiveEntry } from '../src/sync/interactives.js';
import { COL, MANUAL_COLUMNS, cellText, type PrMapping, type RowValues } from '../src/sync/mapper.js';
import {
  runSync,
  type PullRequestSource,
  type ReviewerLevel,
  type RowMatch,
  type SheetRow,
  type SheetStore,
} from '../src/sync/synchronizer.js';
import { ARJUN, RITHIKA_S, SHRAVYA, makePr, participant } from './fixtures.js';

// ---------------------------------------------------------------------------
// In-memory fakes
// ---------------------------------------------------------------------------

class FakeBitbucket implements PullRequestSource {
  prs = new Map<number, BbPullRequest>();
  failing = new Set<number>();
  authBroken = false;
  detailCalls: number[] = [];

  put(pr: BbPullRequest) {
    this.prs.set(pr.id, pr);
  }
  async listOpenPullRequestIds() {
    return [...this.prs.values()].filter((p) => p.state === 'OPEN').map((p) => p.id);
  }
  async listPullRequestIdsUpdatedSince(since: Date | null) {
    return [...this.prs.values()]
      .filter((p) => !since || Date.parse(p.updated_on) >= since.getTime())
      .map((p) => p.id);
  }
  async getPullRequest(id: number) {
    this.detailCalls.push(id);
    if (this.authBroken) throw new AuthError('bitbucket: HTTP 401');
    if (this.failing.has(id)) throw new Error(`bitbucket: HTTP 500 for PR ${id}`);
    return structuredClone(this.prs.get(id) ?? null);
  }
}

class FakeSheet implements SheetStore {
  rows: Array<Record<string, unknown>> = [];
  mappings: PrMapping[] = [];
  levels: ReviewerLevel[] = [];
  inserts: RowValues[] = [];
  updates: Array<{ match: RowMatch; values: RowValues }> = [];
  headers: Set<string> | null = null;
  interactives: InteractiveEntry[] = [];

  async readInteractives() {
    return this.interactives;
  }

  columns() {
    return this.headers;
  }

  async readRows(): Promise<SheetRow[]> {
    return this.rows.map((values, i) => ({ rowIndex: i + 2, values: { ...values } }));
  }
  async readPrMappings() {
    return this.mappings;
  }
  async readReviewerLevels() {
    return this.levels;
  }
  async insertRows(rows: RowValues[]) {
    this.inserts.push(...rows);
    this.rows.push(...rows.map(asZohoStores));
  }
  async updateRows(match: RowMatch, values: RowValues) {
    this.updates.push({ match, values });
    const targets =
      'syncKey' in match
        ? this.rows.filter((r) => r[COL.syncKey] === match.syncKey)
        : this.rows
            .filter(
              (r) => String(r[COL.prId]) === String(match.legacy.prId) && r[COL.reviewer] === match.legacy.reviewerName,
            )
            .slice(0, 1);
    if (targets.length === 0) throw new Error(`no row matched ${JSON.stringify(match)}`);
    for (const t of targets) Object.assign(t, asZohoStores(values));
  }
  resetCalls() {
    this.inserts = [];
    this.updates = [];
  }
  keys() {
    return this.rows.map((r) => r[COL.syncKey]);
  }
}

/** Zoho returns only the text of a hyperlink cell. */
function asZohoStores(values: RowValues): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, typeof v === 'object' ? cellText(v) : v]));
}

function recordingLogger(): Logger & { events: Array<{ event: string; fields: LogFields }> } {
  const events: Array<{ event: string; fields: LogFields }> = [];
  return {
    events,
    event: (_level, event, fields = {}) => events.push({ event, fields }),
    pr: (prId, fields) => events.push({ event: 'PR', fields: { prId, ...fields } }),
    addSecrets: () => {},
  };
}

const MAPPING_123: PrMapping = {
  prId: 123,
  interactiveName: 'WNO_storyAnimations',
  developer: 'Rithika M',
  interactiveType: 'Static',
  phase: 'SPEC',
  prLabel: 'PR1',
};

// ---------------------------------------------------------------------------

describe('runSync', () => {
  let bb: FakeBitbucket;
  let sheet: FakeSheet;
  const deps = (logger: Logger = silentLogger) => ({
    source: bb,
    sheet,
    logger,
    timeZone: 'UTC',
    now: () => new Date('2026-09-23T06:00:00Z'),
  });

  beforeEach(() => {
    bb = new FakeBitbucket();
    sheet = new FakeSheet();
    sheet.mappings = [MAPPING_123];
    sheet.levels = [
      { reviewerId: RITHIKA_S.uuid!, reviewerName: 'Rithika S', level: 'L1' },
      { reviewerId: null, reviewerName: 'Shravya', level: 'L1' },
    ];
    bb.put(
      makePr({
        id: 123,
        reviewers: [RITHIKA_S, SHRAVYA],
        participants: [participant(RITHIKA_S, null), participant(SHRAVYA, 'changes_requested')],
      }),
    );
  });

  it('first sync inserts one row per reviewer with manual fields from the mapping', async () => {
    const s = await runSync(deps());
    assert.equal(s.inserted, 2);
    assert.equal(s.failed, 0);
    assert.deepEqual(sheet.keys(), ['123:{11111111-aaaa}', '123:{22222222-bbbb}']);

    const shravya = sheet.rows.find((r) => r[COL.reviewer] === 'Shravya')!;
    assert.equal(shravya[COL.developer], 'Rithika M');
    assert.equal(shravya[COL.interactiveName], 'WNO_storyAnimations');
    assert.equal(shravya[COL.phase], 'SPEC');
    assert.equal(shravya[COL.reviewStatus], 'Requested Changes');
    assert.equal(shravya[COL.reviewerLevel], 'L1');
    assert.equal(shravya[COL.prStatus], 'OPEN');
    assert.equal(shravya[COL.lastSyncedAt], '2026-09-23 06:00:00');
  });

  it('is idempotent: a second run with no Bitbucket changes writes nothing', async () => {
    await runSync(deps());
    sheet.resetCalls();
    const s = await runSync(deps());
    assert.equal(s.inserted, 0);
    assert.equal(s.updated, 0);
    assert.equal(s.unchanged, 2);
    assert.equal(sheet.inserts.length + sheet.updates.length, 0);
    assert.equal(sheet.rows.length, 2);
  });

  it('updates only the changed row when a reviewer approves', async () => {
    await runSync(deps());
    sheet.resetCalls();
    bb.put(
      makePr({
        id: 123,
        reviewers: [RITHIKA_S, SHRAVYA],
        participants: [participant(RITHIKA_S, 'approved'), participant(SHRAVYA, 'changes_requested')],
      }),
    );
    const s = await runSync(deps());
    assert.equal(s.updated, 1);
    assert.equal(s.unchanged, 1);
    assert.equal(sheet.updates.length, 1);
    assert.deepEqual(sheet.updates[0]!.match, { syncKey: '123:{11111111-aaaa}' });
    assert.equal(sheet.updates[0]!.values[COL.reviewStatus], 'Approved');
    assert.equal(sheet.rows.length, 2);
  });

  it('never sends manual columns in an update, and preserves hand edits', async () => {
    await runSync(deps());
    sheet.rows[0]![COL.developer] = 'Edited by hand';
    sheet.rows[0]![COL.phase] = 'DEV';
    sheet.mappings = [{ ...MAPPING_123, developer: 'Mapping changed' }];
    bb.put(makePr({ id: 123, state: 'MERGED', reviewers: [RITHIKA_S, SHRAVYA] }));

    await runSync(deps());
    assert.ok(sheet.updates.length > 0);
    for (const u of sheet.updates) {
      for (const col of MANUAL_COLUMNS) assert.ok(!(col in u.values), `update touched manual column ${col}`);
    }
    assert.equal(sheet.rows[0]![COL.developer], 'Edited by hand');
    assert.equal(sheet.rows[0]![COL.phase], 'DEV');
    assert.equal(sheet.rows[0]![COL.prStatus], 'MERGED');
  });

  it('inserts a row for a newly added reviewer without duplicating existing ones', async () => {
    await runSync(deps());
    bb.put(makePr({ id: 123, reviewers: [RITHIKA_S, SHRAVYA, ARJUN] }));
    const s = await runSync(deps());
    assert.equal(s.inserted, 1);
    assert.equal(sheet.rows.length, 3);
    assert.equal(new Set(sheet.keys()).size, 3);
  });

  it('updates the same row when a reviewer changes display name (identity is the UUID)', async () => {
    await runSync(deps());
    const renamed = { ...SHRAVYA, display_name: 'Shravya K' };
    bb.put(makePr({ id: 123, reviewers: [RITHIKA_S, renamed], participants: [participant(renamed, 'changes_requested')] }));
    const s = await runSync(deps());
    assert.equal(s.inserted, 0);
    assert.equal(sheet.rows.length, 2);
    assert.ok(sheet.rows.some((r) => r[COL.reviewer] === 'Shravya K'));
  });

  it('logs UNMAPPED_PR and inserts nothing for an unmapped PR', async () => {
    bb.put(makePr({ id: 789, reviewers: [ARJUN] }));
    const logger = recordingLogger();
    const s = await runSync(deps(logger));
    assert.equal(s.unmapped, 1);
    assert.ok(!sheet.rows.some((r) => r[COL.prId] === '#789'));
    assert.ok(logger.events.some((e) => e.fields.prId === 789 && e.fields.action === 'UNMAPPED_PR'));
  });

  it('picks up a PR once it is mapped, even if Bitbucket has not changed it since', async () => {
    const old = makePr({ id: 789, state: 'MERGED', updated_on: '2026-01-01T00:00:00+00:00', reviewers: [ARJUN] });
    bb.put(old);
    await runSync(deps(), { since: new Date('2026-09-01T00:00:00Z') });
    assert.ok(!sheet.rows.some((r) => r[COL.prId] === '#789'));

    sheet.mappings.push({ ...MAPPING_123, prId: 789, interactiveName: 'Fractions_intro' });
    const s = await runSync(deps(), { since: new Date('2026-09-22T00:00:00Z') });
    assert.equal(s.inserted, 1);
    assert.equal(sheet.rows.find((r) => r[COL.prId] === '#789')![COL.interactiveName], 'Fractions_intro');
  });

  it('uses an existing sheet row for the same PR as the mapping source', async () => {
    sheet.mappings = [];
    sheet.rows.push({
      [COL.developer]: 'Rithika M',
      [COL.interactiveType]: 'Static',
      [COL.interactiveName]: 'WNO_storyAnimations',
      [COL.phase]: 'SPEC',
      [COL.pr]: 'PR1',
      [COL.prId]: 123,
      [COL.reviewer]: 'Rithika S',
      [COL.syncKey]: '123:{11111111-aaaa}',
    });
    const s = await runSync(deps());
    assert.equal(s.inserted, 1);
    assert.equal(sheet.rows.find((r) => r[COL.reviewer] === 'Shravya')![COL.interactiveName], 'WNO_storyAnimations');
  });

  it('adopts a hand-entered row (no Sync Key) instead of inserting a duplicate', async () => {
    sheet.rows.push({
      [COL.developer]: 'Rithika M',
      [COL.interactiveName]: 'WNO_storyAnimations',
      [COL.prId]: '123',
      [COL.reviewer]: 'Shravya',
      [COL.reviewStatus]: 'Pending',
    });
    const s = await runSync(deps());
    assert.equal(sheet.rows.filter((r) => r[COL.reviewer] === 'Shravya').length, 1);
    const adopted = sheet.rows.find((r) => r[COL.reviewer] === 'Shravya')!;
    assert.equal(adopted[COL.syncKey], '123:{22222222-bbbb}');
    assert.equal(adopted[COL.reviewStatus], 'Requested Changes');
    assert.equal(adopted[COL.developer], 'Rithika M');
    assert.equal(s.inserted, 1); // Rithika S only

    sheet.resetCalls();
    const again = await runSync(deps());
    assert.equal(again.inserted + again.updated, 0);
  });

  it('continues with remaining PRs when one PR fails', async () => {
    sheet.mappings.push({ ...MAPPING_123, prId: 124 }, { ...MAPPING_123, prId: 125 });
    bb.put(makePr({ id: 124, reviewers: [ARJUN] }));
    bb.put(makePr({ id: 125, reviewers: [ARJUN] }));
    bb.failing.add(124);
    const s = await runSync(deps());
    assert.equal(s.failed, 1);
    assert.equal(s.aborted, null);
    assert.equal(s.inserted, 3); // 2 for PR 123, 1 for PR 125
  });

  it('aborts the run on authentication failure instead of hammering the API', async () => {
    sheet.mappings.push({ ...MAPPING_123, prId: 124 });
    bb.put(makePr({ id: 124, reviewers: [ARJUN] }));
    bb.authBroken = true;
    const s = await runSync(deps());
    assert.match(s.aborted ?? '', /401/);
    assert.equal(s.failed, 2);
    assert.equal(bb.detailCalls.length, 1);
    assert.equal(sheet.rows.length, 0);
  });

  it('counts a mapped PR that no longer exists as missing, not failed', async () => {
    sheet.mappings.push({ ...MAPPING_123, prId: 999 });
    const s = await runSync(deps());
    assert.equal(s.missing, 1);
    assert.equal(s.failed, 0);
  });

  it('marks merged PRs even when they fall outside the incremental window', async () => {
    await runSync(deps());
    bb.put(makePr({ id: 123, state: 'MERGED', updated_on: '2026-01-01T00:00:00+00:00', reviewers: [RITHIKA_S, SHRAVYA] }));
    await runSync(deps(), { since: new Date('2026-09-22T00:00:00Z') });
    assert.ok(sheet.rows.every((r) => r[COL.prStatus] === 'MERGED'));
  });

  it('keeps Review Status unchanged and logs the raw value for unknown review states', async () => {
    await runSync(deps());
    bb.put(makePr({ id: 123, reviewers: [RITHIKA_S, SHRAVYA], participants: [participant(SHRAVYA, 'needs_work')] }));
    const logger = recordingLogger();
    await runSync(deps(logger));
    assert.equal(sheet.rows.find((r) => r[COL.reviewer] === 'Shravya')![COL.reviewStatus], 'Requested Changes');
    assert.ok(logger.events.some((e) => e.event === 'UNKNOWN_REVIEW_STATE' && e.fields.rawState === 'needs_work'));
  });

  it('does not blank out a Reviewer Level typed by hand when the level is unknown', async () => {
    sheet.levels = [];
    await runSync(deps());
    sheet.rows[0]![COL.reviewerLevel] = 'L2';
    await runSync(deps());
    assert.equal(sheet.rows[0]![COL.reviewerLevel], 'L2');
  });

  describe('with insertUnmapped', () => {
    const depsAll = (logger: Logger = silentLogger) => ({ ...deps(logger), insertUnmapped: true });

    it('inserts every PR, leaving manual columns blank for unmapped ones, in one call per PR', async () => {
      bb.put(makePr({ id: 789, reviewers: [ARJUN, SHRAVYA] }));
      const logger = recordingLogger();
      const s = await runSync(depsAll(logger));
      assert.equal(s.inserted, 4);
      assert.equal(s.unmapped, 1);
      const rows789 = sheet.rows.filter((r) => r[COL.prId] === '#789');
      assert.equal(rows789.length, 2);
      for (const r of rows789) {
        assert.equal(r[COL.developer], 'Rithika M', 'Developer defaults to the PR author');
        for (const col of MANUAL_COLUMNS.filter((c) => c !== COL.developer)) assert.ok(!r[col], `${col} should be blank`);
        assert.equal(r[COL.prStatus], 'OPEN');
      }
      assert.ok(logger.events.some((e) => e.fields.prId === 789 && e.fields.action === 'UNMAPPED_PR'));

      sheet.resetCalls();
      const again = await runSync(depsAll());
      assert.equal(again.inserted + again.updated, 0);
      assert.equal(sheet.rows.length, 4);
    });

    it('fills blank manual cells once the PR is mapped, without overwriting typed values', async () => {
      bb.put(makePr({ id: 789, state: 'MERGED', updated_on: '2026-01-01T00:00:00+00:00', reviewers: [ARJUN, SHRAVYA] }));
      await runSync(depsAll(), { prIds: [789] });
      const [first, second] = sheet.rows.filter((r) => r[COL.prId] === '#789');
      first![COL.phase] = 'DEV'; // typed by hand

      sheet.mappings.push({ ...MAPPING_123, prId: 789, interactiveName: 'Fractions_intro', phase: 'SPEC' });
      const s = await runSync(depsAll(), { since: new Date('2026-09-22T00:00:00Z') });
      assert.equal(s.updated, 2);
      assert.equal(first![COL.interactiveName], 'Fractions_intro');
      assert.equal(first![COL.phase], 'DEV');
      assert.equal(second![COL.phase], 'SPEC');

      sheet.resetCalls();
      await runSync(depsAll(), { since: new Date('2026-09-22T00:00:00Z') });
      assert.equal(sheet.updates.length, 0, 'mapped + filled rows are not re-fetched or rewritten');
    });

    it('copies manual fields from a row the user filled in when a new reviewer is added', async () => {
      bb.put(makePr({ id: 789, reviewers: [ARJUN] }));
      await runSync(depsAll());
      const arjun = sheet.rows.find((r) => r[COL.prId] === '#789')!;
      arjun[COL.interactiveName] = 'Fractions_intro';
      arjun[COL.developer] = 'Rithika M';

      bb.put(makePr({ id: 789, reviewers: [ARJUN, SHRAVYA] }));
      const s = await runSync(depsAll());
      assert.equal(s.unmapped, 0);
      const shravya = sheet.rows.find((r) => r[COL.prId] === '#789' && r[COL.reviewer] === 'Shravya')!;
      assert.equal(shravya[COL.interactiveName], 'Fractions_intro');
      assert.equal(shravya[COL.developer], 'Rithika M');
    });
  });

  it('fills a blank Developer from the PR author, but never overrides the mapping or a typed value', async () => {
    const author = { uuid: '{dev}', display_name: 'Rithika Murugan' };
    sheet.mappings = [{ ...MAPPING_123, developer: '' }];
    bb.put(makePr({ id: 123, author, reviewers: [RITHIKA_S, SHRAVYA] }));
    await runSync(deps());
    assert.ok(sheet.rows.every((r) => r[COL.developer] === 'Rithika Murugan'));

    sheet.rows[0]![COL.developer] = 'Typed by hand';
    sheet.rows[1]![COL.developer] = '';
    sheet.mappings = [{ ...MAPPING_123, developer: 'From mapping' }];
    await runSync(deps());
    assert.equal(sheet.rows[0]![COL.developer], 'Typed by hand');
    assert.equal(sheet.rows[1]![COL.developer], 'From mapping', 'mapping wins over author for blank cells');
  });

  describe('PR-level columns (sheet has PR Count / Days Open headers)', () => {
    beforeEach(() => {
      sheet.headers = new Set([...Object.values(COL)]);
    });

    it('sets PR Count = 1 on exactly one row per PR and fills Days Open', async () => {
      bb.put(makePr({ id: 124, reviewers: [ARJUN] }));
      sheet.mappings.push({ ...MAPPING_123, prId: 124 });
      await runSync(deps());
      for (const id of ['#123', '#124']) {
        const rows = sheet.rows.filter((r) => r[COL.prId] === id);
        assert.equal(rows.reduce((n, r) => n + Number(r[COL.prCount]), 0), 1, `PR ${id} counted once`);
      }
      assert.equal(sheet.rows[0]![COL.daysOpen], 21); // created 2026-09-01 10:00, now 2026-09-23 06:00 (OPEN)
    });

    it('stays idempotent and moves PR Count when the counted row disappears from the key order', async () => {
      await runSync(deps());
      sheet.resetCalls();
      await runSync(deps());
      assert.equal(sheet.updates.length, 0);

      // New reviewer whose key sorts first takes over PR Count; the old primary drops to 0.
      const early = { uuid: '{00000000-0000}', display_name: 'Aaron' };
      bb.put(makePr({ id: 123, reviewers: [early, RITHIKA_S, SHRAVYA] }));
      await runSync(deps());
      const counts = sheet.rows.map((r) => [r[COL.reviewer], r[COL.prCount]]);
      assert.deepEqual(counts.filter(([, c]) => c === 1), [['Aaron', 1]]);
    });

    it('keeps PR Count on a removed reviewer row consistent', async () => {
      await runSync(deps());
      bb.put(makePr({ id: 123, reviewers: [SHRAVYA] })); // Rithika S (primary) removed
      await runSync(deps());
      const total = sheet.rows.reduce((n, r) => n + Number(r[COL.prCount]), 0);
      assert.equal(total, 1);
    });

    it('does not write PR Count / Days Open when the sheet lacks those headers', async () => {
      sheet.headers = new Set(Object.values(COL).filter((c) => c !== COL.prCount && c !== COL.daysOpen));
      await runSync(deps());
      for (const r of sheet.rows) assert.ok(!(COL.prCount in r) && !(COL.daysOpen in r));
      sheet.resetCalls();
      await runSync(deps());
      assert.equal(sheet.updates.length, 0);
    });
  });

  describe('interactive auto-detection', () => {
    const depsAll = () => ({ ...deps(), insertUnmapped: true });
    beforeEach(() => {
      sheet.mappings = [];
      sheet.interactives = [
        { name: 'SHA_qcode_11757_ans.html', type: 'Static' },
        { name: 'DEC_qcode_1060_ans.html', type: 'Static' },
      ];
    });

    it('fills Interactive Name and Type on new rows from the PR title', async () => {
      bb.put(makePr({ id: 74, title: 'EIT-5465: specs — rotation_transform (SHA_qcode_11757_ans)', reviewers: [ARJUN] }));
      const s = await runSync(depsAll(), { prIds: [74] });
      const row = sheet.rows.find((r) => r[COL.prId] === '#74')!;
      assert.equal(row[COL.interactiveName], 'SHA_qcode_11757_ans.html');
      assert.equal(row[COL.interactiveType], 'Static');
      assert.equal(s.unmapped, 0);
    });

    it('fills blank names on existing rows, never overwrites a typed name', async () => {
      bb.put(makePr({ id: 74, title: 'rotation (SHA_qcode_11757_ans)', reviewers: [ARJUN, SHRAVYA] }));
      sheet.interactives = [];
      await runSync(depsAll(), { prIds: [74] }); // inserted with no name
      sheet.interactives = [{ name: 'SHA_qcode_11757_ans.html', type: 'Static' }];
      await runSync(depsAll(), { prIds: [74] });
      assert.ok(sheet.rows.every((r) => r[COL.interactiveName] === 'SHA_qcode_11757_ans.html'));

      sheet.rows[0]![COL.interactiveName] = 'Typed_by_hand.html';
      sheet.rows[1]![COL.interactiveName] = '';
      await runSync(depsAll(), { prIds: [74] });
      assert.equal(sheet.rows[0]![COL.interactiveName], 'Typed_by_hand.html');
      assert.equal(sheet.rows[1]![COL.interactiveName], 'Typed_by_hand.html', 'blank sibling follows the typed row');
    });

    it('leaves the name blank when the PR names several interactives', async () => {
      bb.put(makePr({ id: 64, title: 'Widgetbook: SHA_qcode_11757_ans and DEC_qcode_1060_ans', reviewers: [ARJUN] }));
      await runSync(depsAll(), { prIds: [64] });
      assert.ok(!sheet.rows.find((r) => r[COL.prId] === '#64')![COL.interactiveName]);
    });

    it('re-checks unnamed PRs only when the interactives list changes', async () => {
      const old = makePr({ id: 30, state: 'MERGED', updated_on: '2026-01-01T00:00:00+00:00', title: 'DEC026 NEW_qcode_99', reviewers: [ARJUN] });
      bb.put(old);
      await runSync(depsAll(), { prIds: [30] });
      const since = new Date('2026-09-22T00:00:00Z');
      const first = await runSync(depsAll(), { since, previousInteractivesFingerprint: null });
      bb.detailCalls = [];
      await runSync(depsAll(), { since, previousInteractivesFingerprint: first.interactivesFingerprint });
      assert.ok(!bb.detailCalls.includes(30), 'unchanged list: merged unnamed PR not re-fetched');

      sheet.interactives.push({ name: 'NEW_qcode_99.html', type: 'Static' });
      await runSync(depsAll(), { since, previousInteractivesFingerprint: first.interactivesFingerprint });
      assert.equal(sheet.rows.find((r) => r[COL.prId] === '#30')![COL.interactiveName], 'NEW_qcode_99.html');
    });
  });

  describe('Build Drop Date', () => {
    const depsAll = () => ({ ...deps(), insertUnmapped: true });
    beforeEach(() => {
      sheet.mappings = [];
      sheet.interactives = [{ name: 'SHA_qcode_11757_ans.html', type: 'Static', buildDrop: '29/9/2026' }];
    });

    it('copies the interactive\'s build drop date onto new rows', async () => {
      bb.put(makePr({ id: 74, title: 'rotation (SHA_qcode_11757_ans)', reviewers: [ARJUN] }));
      await runSync(depsAll(), { prIds: [74] });
      assert.equal(sheet.rows.find((r) => r[COL.prId] === '#74')![COL.buildDropDate], '29/9/2026');
    });

    it('follows date changes in the interactives sheet without the PR changing', async () => {
      bb.put(makePr({ id: 74, state: 'MERGED', updated_on: '2026-01-01T00:00:00+00:00', title: 'SHA_qcode_11757_ans', reviewers: [ARJUN] }));
      await runSync(depsAll(), { prIds: [74] });
      const since = new Date('2026-09-22T00:00:00Z');
      const first = await runSync(depsAll(), { since, previousInteractivesFingerprint: null });

      sheet.interactives[0]!.buildDrop = '9/10/2026';
      sheet.resetCalls();
      bb.detailCalls = [];
      await runSync(depsAll(), { since, previousInteractivesFingerprint: first.interactivesFingerprint });
      assert.equal(sheet.rows.find((r) => r[COL.prId] === '#74')![COL.buildDropDate], '9/10/2026');
      assert.ok(!bb.detailCalls.includes(74), 'no Bitbucket call needed');

      sheet.resetCalls();
      await runSync(depsAll(), { since, previousInteractivesFingerprint: first.interactivesFingerprint });
      assert.equal(sheet.updates.length, 0, 'idempotent');
    });

    it('leaves rows alone whose interactive is not in the sheet, and skips a missing header', async () => {
      bb.put(makePr({ id: 74, title: 'SHA_qcode_11757_ans', reviewers: [ARJUN] }));
      sheet.headers = new Set(Object.values(COL).filter((c) => c !== COL.buildDropDate));
      await runSync(depsAll());
      assert.ok(sheet.rows.every((r) => !(COL.buildDropDate in r)));
    });
  });

  it('targeted sync (webhook path) only touches the given PRs', async () => {
    sheet.mappings.push({ ...MAPPING_123, prId: 124 });
    bb.put(makePr({ id: 124, reviewers: [ARJUN] }));
    const s = await runSync(deps(), { prIds: [124, 124] });
    assert.equal(s.prsConsidered, 1);
    assert.deepEqual(bb.detailCalls, [124]);
    assert.equal(sheet.rows.length, 1);
  });
});
