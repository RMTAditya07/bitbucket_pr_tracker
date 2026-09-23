import { extractReviewers } from '../bitbucket/reviewers.js';
import type { BbPullRequest } from '../bitbucket/types.js';
import { AuthError } from '../http/request.js';
import type { Logger } from '../logger/logger.js';
import { buildSyncKey, normalizeName, normalizeUuid, parsePrId } from './identity.js';
import { buildMatcher, type InteractiveEntry, type InteractiveMatcher } from './interactives.js';
import {
  COL,
  buildSyncedFields,
  cellEquals,
  cellText,
  daysOpen,
  diffSyncedFields,
  fillBlankManualFields,
  formatDateTime,
  normalizePrState,
  resolveManualFields,
  type PrMapping,
  type RowValues,
} from './mapper.js';

// ---------------------------------------------------------------------------
// Ports — implemented by the Bitbucket / Zoho adapters and by in-memory fakes in tests.
// ---------------------------------------------------------------------------

export interface PullRequestSource {
  listOpenPullRequestIds(): Promise<number[]>;
  listPullRequestIdsUpdatedSince(since: Date | null): Promise<number[]>;
  getPullRequest(id: number): Promise<BbPullRequest | null>;
}

export interface SheetRow {
  rowIndex: number;
  values: Record<string, unknown>;
}

export interface ReviewerLevel {
  reviewerId: string | null;
  reviewerName: string;
  level: string;
}

/** How to locate the row(s) to update. */
export type RowMatch =
  | { syncKey: string }
  /** Hand-entered row without a Sync Key yet: first row with this PR ID + Reviewer name. */
  | { legacy: { prId: number; reviewerName: string } };

export interface SheetStore {
  readRows(): Promise<SheetRow[]>;
  /** Header columns seen by the last readRows(), or null if unknown. Values for other columns are not written. */
  columns?(): Set<string> | null;
  readPrMappings(): Promise<PrMapping[]>;
  readReviewerLevels(): Promise<ReviewerLevel[]>;
  /** Known interactives (Static/Dynamic Interactives worksheets). Empty = auto-detection off. */
  readInteractives?(): Promise<InteractiveEntry[]>;
  insertRows(rows: RowValues[]): Promise<void>;
  updateRows(match: RowMatch, values: RowValues): Promise<void>;
}

/** Errors after which continuing is pointless (every later call would fail the same way). */
export class FatalSyncError extends Error {}

export interface SyncDeps {
  source: PullRequestSource;
  sheet: SheetStore;
  logger: Logger;
  timeZone: string;
  /** Insert rows for PRs with no interactive mapping, leaving the manual columns blank. */
  insertUnmapped?: boolean;
  now?: () => Date;
}

export interface SyncOptions {
  /** Explicit PR ids (e.g. from a webhook). When set, discovery is skipped. */
  prIds?: number[];
  /** Include PRs updated at/after this instant. null = no lower bound. Ignored when prIds is set. */
  since?: Date | null;
  /**
   * Fingerprint of the interactives list from the previous clean run. When the list has
   * changed (e.g. a new interactive was added), PRs without an Interactive Name are re-checked.
   */
  previousInteractivesFingerprint?: string | null;
}

export interface SyncSummary {
  startedAt: Date;
  finishedAt: Date;
  prsConsidered: number;
  inserted: number;
  updated: number;
  unchanged: number;
  unmapped: number;
  missing: number;
  failed: number;
  aborted: string | null;
  /** Fingerprint of the interactives list seen this run (store it for the next run). */
  interactivesFingerprint: string | null;
}

// ---------------------------------------------------------------------------

export async function runSync(deps: SyncDeps, options: SyncOptions = {}): Promise<SyncSummary> {
  const { logger, source, sheet } = deps;
  const now = deps.now ?? (() => new Date());
  const summary: SyncSummary = {
    startedAt: now(),
    finishedAt: now(),
    prsConsidered: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    unmapped: 0,
    missing: 0,
    failed: 0,
    aborted: null,
    interactivesFingerprint: null,
  };

  logger.event('info', 'SYNC_STARTED', {
    mode: options.prIds ? 'targeted' : options.since ? 'incremental' : 'full',
    since: options.since?.toISOString(),
  });

  try {
    const index = await loadSheetIndex(sheet, logger);
    summary.interactivesFingerprint = index.interactives.fingerprint;
    const rescanUnnamed =
      index.interactives.fingerprint !== '' &&
      index.interactives.fingerprint !== (options.previousInteractivesFingerprint ?? null);
    const prIds = options.prIds
      ? dedupe(options.prIds)
      : await discoverPrIds(source, index, options.since ?? null, rescanUnnamed, logger);
    summary.prsConsidered = prIds.length;

    for (let i = 0; i < prIds.length; i++) {
      const prId = prIds[i]!;
      try {
        await syncOnePr(prId, deps, index, summary, now);
      } catch (err) {
        if (isFatal(err)) {
          const remaining = prIds.length - i;
          summary.failed += remaining;
          summary.aborted = errorMessage(err);
          logger.event('error', 'SYNC_ABORTED', { reason: summary.aborted, prId, remainingPrs: remaining });
          break;
        }
        summary.failed++;
        logger.pr(prId, { action: 'FAILED', error: errorMessage(err) }, 'error');
      }
    }
    // Build drop dates can change in the interactives sheet without any PR changing, so keep
    // every row in step (sheet-only; no Bitbucket calls). Targeted runs cover their own rows.
    if (!options.prIds && !summary.aborted) await syncBuildDrops(deps, index, summary, now);
  } catch (err) {
    // Failure before per-PR processing (reading the sheet, listing PRs): nothing was synced.
    summary.aborted = errorMessage(err);
    logger.event('error', 'SYNC_ABORTED', { reason: summary.aborted });
  }

  summary.finishedAt = now();
  logger.event(summary.aborted ? 'error' : summary.failed ? 'warn' : 'info', 'SYNC_COMPLETED', {
    inserted: summary.inserted,
    updated: summary.updated,
    unchanged: summary.unchanged,
    unmapped: summary.unmapped,
    missing: summary.missing,
    failed: summary.failed,
    durationMs: summary.finishedAt.getTime() - summary.startedAt.getTime(),
  });
  return summary;
}

// ---------------------------------------------------------------------------
// Sheet snapshot
// ---------------------------------------------------------------------------

interface SheetIndex {
  byKey: Map<string, SheetRow[]>;
  byPr: Map<number, SheetRow[]>;
  mappings: Map<number, PrMapping>;
  levelsById: Map<string, string>;
  levelsByName: Map<string, string>;
  warnedLevels: Set<string>;
  interactives: InteractiveMatcher;
}

async function loadSheetIndex(sheet: SheetStore, logger: Logger): Promise<SheetIndex> {
  const [rows, mappings, levels, interactives] = await Promise.all([
    sheet.readRows(),
    sheet.readPrMappings(),
    sheet.readReviewerLevels(),
    sheet.readInteractives?.() ?? Promise.resolve([]),
  ]);

  const index: SheetIndex = {
    byKey: new Map(),
    byPr: new Map(),
    mappings: new Map(),
    levelsById: new Map(),
    levelsByName: new Map(),
    warnedLevels: new Set(),
    interactives: buildMatcher(interactives),
  };

  for (const row of rows) indexRow(index, row);

  for (const [key, dupes] of index.byKey) {
    if (dupes.length > 1) {
      logger.event('warn', 'DUPLICATE_ROWS', {
        syncKey: key,
        rows: dupes.map((r) => r.rowIndex).join(', '),
        note: 'All copies will receive the same updates; delete the extras manually.',
      });
    }
  }

  for (const m of mappings) {
    if (index.mappings.has(m.prId)) {
      logger.event('warn', 'DUPLICATE_MAPPING', { prId: m.prId, note: 'First mapping row wins.' });
      continue;
    }
    index.mappings.set(m.prId, m);
  }

  for (const l of levels) {
    if (!l.level) continue;
    if (l.reviewerId) index.levelsById.set(normalizeUuid(l.reviewerId), l.level);
    if (l.reviewerName) index.levelsByName.set(normalizeName(l.reviewerName), l.level);
  }

  return index;
}

function indexRow(index: SheetIndex, row: SheetRow): void {
  const key = String(row.values[COL.syncKey] ?? '').trim();
  if (key) push(index.byKey, key, row);
  const prId = parsePrId(row.values[COL.prId]);
  if (prId) push(index.byPr, prId, row);
}

// ---------------------------------------------------------------------------
// Discovery: which PRs to look at this run
// ---------------------------------------------------------------------------

async function discoverPrIds(
  source: PullRequestSource,
  index: SheetIndex,
  since: Date | null,
  rescanUnnamed: boolean,
  logger: Logger,
): Promise<number[]> {
  const open = await source.listOpenPullRequestIds();
  const changed = await source.listPullRequestIdsUpdatedSince(since);
  const openSet = new Set(open);

  // Mapped PRs whose rows are missing or still have blank manual cells the mapping can fill —
  // e.g. mapped after a previous run logged UNMAPPED_PR.
  const newlyMapped = [...index.mappings.values()].flatMap((m) => {
    const manual = resolveManualFields(m, []);
    if (!manual) return [];
    const rows = index.byPr.get(m.prId);
    const needsWork = !rows || rows.some((r) => Object.keys(fillBlankManualFields(r.values, manual)).length > 0);
    return needsWork ? [m.prId] : [];
  });

  // Rows still marked OPEN whose PR is no longer open: catches merges/declines even if the
  // incremental window was missed (lost state file, long outage).
  const staleOpen = [...index.byPr.entries()]
    .filter(([id, rows]) => !openSet.has(id) && rows.some((r) => String(r.values[COL.prStatus] ?? '') === 'OPEN'))
    .map(([id]) => id);

  // The interactives list changed (or this is the first run with it): re-check PRs that still
  // have a row without an Interactive Name, since a newly added interactive may now match them.
  const unnamed = rescanUnnamed
    ? [...index.byPr.entries()]
        .filter(([, rows]) => rows.some((r) => !String(r.values[COL.interactiveName] ?? '').trim()))
        .map(([id]) => id)
    : [];

  const ids = dedupe([...open, ...changed, ...newlyMapped, ...staleOpen, ...unnamed]);
  logger.event('info', 'PRS_DISCOVERED', {
    open: open.length,
    updatedSinceLastSync: changed.length,
    newlyMapped: newlyMapped.length,
    staleOpenRows: staleOpen.length,
    withoutInteractive: rescanUnnamed ? unnamed.length : undefined,
    total: ids.length,
  });
  return ids;
}

// ---------------------------------------------------------------------------
// Per-PR sync
// ---------------------------------------------------------------------------

async function syncOnePr(
  prId: number,
  deps: SyncDeps,
  index: SheetIndex,
  summary: SyncSummary,
  now: () => Date,
): Promise<void> {
  const { source, sheet, logger, timeZone } = deps;

  const pr = await source.getPullRequest(prId);
  if (!pr) {
    summary.missing++;
    logger.pr(prId, { action: 'MISSING_PR', note: 'Not found in Bitbucket (deleted, or wrong ID in mapping?)' }, 'warn');
    return;
  }

  const prState = normalizePrState(pr.state);
  if (!prState.status) {
    logger.event('warn', 'UNKNOWN_PR_STATE', { prId, rawState: prState.raw, note: 'PR Status left unchanged' });
  }

  const { reviewers, skipped } = extractReviewers(pr);
  for (const name of skipped) {
    logger.event('warn', 'MISSING_REVIEWER_ID', { prId, reviewer: name, note: 'Account has no uuid/account_id; skipped' });
  }
  if (reviewers.length === 0) {
    logger.pr(prId, { title: pr.title, prStatus: prState.status ?? prState.raw, action: 'NO_REVIEWERS' });
    return;
  }

  const existingForPr = index.byPr.get(prId) ?? [];
  // Manual fields for this PR, in priority order: mapping worksheet → a row the user already
  // filled for this PR → the interactive named in the branch/title/description.
  let manual = resolveManualFields(
    index.mappings.get(prId),
    existingForPr.map((r) => r.values),
  );
  if (!manual) {
    const found = index.interactives.detect({
      branch: pr.source.branch?.name,
      title: pr.title,
      description: pr.description,
    });
    if (found.kind === 'match') {
      manual = { [COL.interactiveName]: found.entry.name };
      logger.pr(prId, { action: 'INTERACTIVE_DETECTED', interactive: found.entry.name, from: found.source });
    } else if (found.kind === 'ambiguous') {
      logger.pr(
        prId,
        {
          action: 'INTERACTIVE_AMBIGUOUS',
          from: found.source,
          candidates: found.candidates.join(', '),
          note: 'Several interactives named — pick one in the Interactive Name column.',
        },
        'warn',
      );
    }
  }
  // Interactive Type comes from the interactives worksheet when the PR's type is blank.
  const interactiveName = String(manual?.[COL.interactiveName] ?? '').trim();
  const catalogType = interactiveName ? index.interactives.lookup(interactiveName)?.type : undefined;
  if (manual && catalogType && !String(manual[COL.interactiveType] ?? '').trim()) {
    manual = { ...manual, [COL.interactiveType]: catalogType };
  }

  // Values that may fill *blank* manual cells on existing rows: the PR author as Developer,
  // then the PR's manual fields from whichever source above. Never overwrites a value.
  const authorName = pr.author?.display_name?.trim() ?? '';
  const blankFills: RowValues = authorName ? { [COL.developer]: authorName } : {};
  for (const [col, v] of Object.entries(manual ?? {})) {
    if (String(v).trim()) blankFills[col] = v;
  }
  const syncedAt = formatDateTime(now(), timeZone);
  const keep = columnFilter(sheet);
  const seenKeys = new Set<string>();
  let unmappedReviewers = 0;

  // Plan every write for this PR first, so PR-level columns (PR Count, Days Open) can be folded
  // into the same Zoho call as each row's other changes.
  interface Op {
    key: string;
    reviewer: string;
    status: string;
    /** Rows already in the sheet (empty for an insert). */
    rows: SheetRow[];
    changes: RowValues;
    match?: RowMatch;
    insert?: RowValues;
    note?: string;
  }
  const ops: Op[] = [];

  for (const reviewer of reviewers) {
    const key = buildSyncKey(prId, reviewer.id);
    seenKeys.add(key);

    if (!reviewer.status) {
      logger.event('warn', 'UNKNOWN_REVIEW_STATE', {
        prId,
        reviewer: reviewer.displayName,
        rawState: reviewer.rawState,
        note: 'Review Status left unchanged',
      });
    }

    const level = lookupLevel(index, reviewer.id, reviewer.displayName, logger);
    const desired = keep(buildSyncedFields(pr, reviewer, level, timeZone));
    const status = reviewer.status ?? `(raw: ${reviewer.rawState})`;
    const base = { key, reviewer: reviewer.displayName, status };
    const keyed = index.byKey.get(key);

    if (keyed) {
      const changes = {
        ...diffSyncedFields(keyed[0]!.values, desired),
        ...keep(fillBlankManualFields(keyed[0]!.values, blankFills)),
      };
      ops.push({ ...base, rows: keyed, changes, match: { syncKey: key } });
      continue;
    }

    const legacy = findLegacyRow(existingForPr, reviewer.displayName);
    if (legacy) {
      const changes = {
        ...keep(fillBlankManualFields(legacy.values, blankFills)),
        ...desired,
        [COL.syncKey]: key,
      };
      const reviewerName = String(legacy.values[COL.reviewer]);
      ops.push({ ...base, rows: [legacy], changes, match: { legacy: { prId, reviewerName } }, note: 'Adopted existing hand-entered row' });
      continue;
    }

    if (!manual && !deps.insertUnmapped) {
      unmappedReviewers++;
      continue;
    }

    // Unmapped + insertUnmapped: manual columns are left blank (Developer defaults to the author).
    const insertManual: RowValues = { ...(manual ?? {}) };
    if (!String(insertManual[COL.developer] ?? '').trim() && authorName) insertManual[COL.developer] = authorName;
    ops.push({ ...base, rows: [], changes: {}, insert: keep({ ...insertManual, ...desired, [COL.syncKey]: key }) });
  }

  // Rows of reviewers no longer on the PR still need correct PR-level columns.
  for (const row of existingForPr) {
    const key = String(row.values[COL.syncKey] ?? '').trim();
    if (!key || seenKeys.has(key) || ops.some((o) => o.key === key)) continue;
    const reviewer = String(row.values[COL.reviewer] ?? '');
    logger.event('warn', 'REVIEWER_REMOVED', {
      prId,
      reviewer,
      row: row.rowIndex,
      note: 'No longer a reviewer in Bitbucket; only PR-level columns are kept up to date.',
    });
    ops.push({ key, reviewer, status: '(removed)', rows: index.byKey.get(key) ?? [row], changes: {}, match: { syncKey: key } });
  }

  // PR Count = 1 on exactly one row per PR (lowest Sync Key), so pivots can SUM it to count PRs.
  const primaryKey = ops.map((o) => o.key).sort()[0];
  const prLevel = (key: string, row: Record<string, unknown>): RowValues => {
    const drop = buildDropFor(index, cellText(row[COL.interactiveName]));
    return keep({
      [COL.prCount]: key === primaryKey ? 1 : 0,
      [COL.daysOpen]: daysOpen(pr, now()),
      ...(drop === undefined ? {} : { [COL.buildDropDate]: drop }),
    });
  };

  const inserts: Op[] = [];
  for (const op of ops) {
    if (op.insert) {
      op.insert = { ...op.insert, ...prLevel(op.key, op.insert), [COL.lastSyncedAt]: syncedAt };
      inserts.push(op);
      continue;
    }
    for (const [col, v] of Object.entries(prLevel(op.key, { ...op.rows[0]!.values, ...op.changes }))) {
      if (!cellEquals(col, op.rows[0]!.values[col], v)) op.changes[col] = v;
    }
    if (Object.keys(op.changes).length === 0) {
      summary.unchanged++;
      if (op.status !== '(removed)') logger.pr(prId, { reviewer: op.reviewer, status: op.status, action: 'UNCHANGED' });
      continue;
    }
    const values = { ...op.changes, [COL.lastSyncedAt]: syncedAt };
    await sheet.updateRows(op.match!, values);
    for (const row of op.rows) Object.assign(row.values, values);
    if ('legacy' in op.match!) push(index.byKey, op.key, op.rows[0]!);
    summary.updated++;
    logger.pr(prId, {
      reviewer: op.reviewer,
      status: op.status,
      action: 'UPDATED',
      changed: Object.keys(op.changes).join(', '),
      note: op.note,
    });
  }

  // One Zoho call per PR rather than per reviewer.
  if (inserts.length > 0) {
    await sheet.insertRows(inserts.map((op) => op.insert!));
    for (const op of inserts) {
      const row: SheetRow = { rowIndex: -1, values: { ...op.insert! } };
      push(index.byKey, op.key, row);
      push(index.byPr, prId, row);
      summary.inserted++;
      logger.pr(prId, { reviewer: op.reviewer, status: op.status, action: 'INSERTED' });
    }
  }

  if (!manual) {
    summary.unmapped++;
    logger.pr(
      prId,
      {
        action: 'UNMAPPED_PR',
        title: pr.title,
        sourceBranch: pr.source.branch?.name,
        reviewersNotInserted: unmappedReviewers || undefined,
        note: deps.insertUnmapped
          ? 'Rows are in the sheet with Interactive/Phase blank (Developer = PR author) — fill them in, or add the PR to the mapping worksheet.'
          : 'Add this PR ID to the mapping worksheet; rows will be inserted on the next sync.',
      },
      'warn',
    );
  }
}

/**
 * A hand-entered row for this PR with the same reviewer name and no Sync Key. Adopting it
 * (writing the key) prevents the first sync against an existing sheet from duplicating it.
 * Skipped when a keyed row already uses that name (two accounts with the same display name).
 */
function findLegacyRow(rows: SheetRow[], displayName: string): SheetRow | undefined {
  const name = normalizeName(displayName);
  const sameName = rows.filter((r) => normalizeName(String(r.values[COL.reviewer] ?? '')) === name);
  if (sameName.some((r) => String(r.values[COL.syncKey] ?? '').trim())) return undefined;
  const candidate = sameName[0];
  if (candidate && String(candidate.values[COL.reviewer]).includes('"')) return undefined; // unsafe in criteria
  return candidate;
}

/**
 * Build drop date for a row's interactive, from the interactives worksheet. undefined = the
 * interactive is unknown (or the row has none), so the cell is left alone.
 */
function buildDropFor(index: SheetIndex, interactiveName: string): string | undefined {
  const name = interactiveName.trim();
  if (!name) return undefined;
  const entry = index.interactives.lookup(name);
  return entry ? (entry.buildDrop ?? '') : undefined;
}

async function syncBuildDrops(deps: SyncDeps, index: SheetIndex, summary: SyncSummary, now: () => Date) {
  const keep = columnFilter(deps.sheet);
  if (!(COL.buildDropDate in keep({ [COL.buildDropDate]: '' }))) return; // column not in the sheet
  const syncedAt = formatDateTime(now(), deps.timeZone);
  let changed = 0;
  for (const [key, rows] of index.byKey) {
    const want = buildDropFor(index, cellText(rows[0]!.values[COL.interactiveName]));
    if (want === undefined || cellEquals(COL.buildDropDate, rows[0]!.values[COL.buildDropDate], want)) continue;
    const values = { [COL.buildDropDate]: want, [COL.lastSyncedAt]: syncedAt };
    try {
      await deps.sheet.updateRows({ syncKey: key }, values);
    } catch (err) {
      if (isFatal(err)) throw err;
      summary.failed++;
      deps.logger.event('error', 'BUILD_DROP_FAILED', { syncKey: key, error: errorMessage(err) });
      continue;
    }
    for (const row of rows) Object.assign(row.values, values);
    summary.updated++;
    changed++;
  }
  if (changed) deps.logger.event('info', 'BUILD_DROP_DATES_UPDATED', { rows: changed });
}

/** Drops values for columns the sheet does not have (e.g. optional PR Count / Days Open). */
function columnFilter(sheet: SheetStore): (values: RowValues) => RowValues {
  const cols = sheet.columns?.() ?? null;
  if (!cols) return (v) => v;
  return (values) => Object.fromEntries(Object.entries(values).filter(([col]) => cols.has(col)));
}

function lookupLevel(index: SheetIndex, reviewerId: string, name: string, logger: Logger): string | undefined {
  const byId = reviewerId.startsWith('acct:') ? undefined : index.levelsById.get(reviewerId);
  const level = byId ?? index.levelsByName.get(normalizeName(name));
  if (!level && !index.warnedLevels.has(reviewerId)) {
    index.warnedLevels.add(reviewerId);
    logger.event('warn', 'UNKNOWN_REVIEWER_LEVEL', {
      reviewer: name,
      reviewerId,
      note: 'Add to the reviewer-levels worksheet; Reviewer Level left unchanged',
    });
  }
  return level;
}

function isFatal(err: unknown): boolean {
  return err instanceof AuthError || err instanceof FatalSyncError;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function dedupe(ids: number[]): number[] {
  return [...new Set(ids)].sort((a, b) => a - b);
}
