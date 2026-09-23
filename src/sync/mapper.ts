import type { PrReviewer } from '../bitbucket/reviewers.js';
import type { BbPullRequest } from '../bitbucket/types.js';

export type ReviewStatus = 'Approved' | 'Requested Changes' | 'Pending';
export type PrStatus = 'OPEN' | 'MERGED' | 'DECLINED' | 'SUPERSEDED';
/** A clickable cell. Written to Zoho as =HYPERLINK(url,text); Zoho reads back only `text`. */
export interface Hyperlink {
  url: string;
  text: string;
}
export type CellValue = string | number | Hyperlink;
export type RowValues = Record<string, CellValue>;

/** Sheet column headers. Must match the header row in Zoho exactly. */
export const COL = {
  developer: 'Developer',
  interactiveType: 'Interactive Type',
  interactiveName: 'Interactive Name',
  phase: 'Phase',
  pr: 'PR',
  prId: 'PR ID',
  reviewerLevel: 'Reviewer Level',
  reviewer: 'Reviewer',
  reviewStatus: 'Review Status',
  prStatus: 'PR Status',
  sourceBranch: 'Source Branch',
  targetBranch: 'Target Branch',
  createdAt: 'Created At',
  updatedAt: 'Updated At',
  lastSyncedAt: 'Last Synced At',
  prCount: 'PR Count',
  daysOpen: 'Days Open',
  buildDropDate: 'Build Drop Date',
  syncKey: 'Sync Key',
} as const;

export const SHEET_COLUMNS: string[] = Object.values(COL);

/**
 * Human-maintained columns. Filled from the mapping only when a row is first inserted, and
 * never included in an update payload. "PR" (e.g. PR1/PR2) lives here because Bitbucket
 * has no notion of a per-interactive PR ordinal — see README "Open questions".
 */
export const MANUAL_COLUMNS: readonly string[] = [
  COL.developer,
  COL.interactiveType,
  COL.interactiveName,
  COL.phase,
  COL.pr,
];

/** Columns the sync compares and overwrites. */
export const SYNCED_COLUMNS: readonly string[] = [
  COL.prId,
  COL.reviewerLevel,
  COL.reviewer,
  COL.reviewStatus,
  COL.prStatus,
  COL.sourceBranch,
  COL.targetBranch,
  COL.createdAt,
  COL.updatedAt,
];

const DATE_COLUMNS = new Set<string>([COL.createdAt, COL.updatedAt, COL.lastSyncedAt, COL.buildDropDate]);

// ---------------------------------------------------------------------------
// State normalization
// ---------------------------------------------------------------------------

/**
 * Bitbucket participant `state` → sheet value. `approved` boolean is a fallback for payloads
 * without `state`. Unknown states return `status: undefined` so the caller can log the raw
 * value instead of inventing an interpretation.
 */
export function normalizeReviewState(
  state: string | null | undefined,
  approved = false,
): { status: ReviewStatus | undefined; raw: string } {
  const raw = state ?? (approved ? 'approved' : 'null');
  switch ((state ?? '').toLowerCase()) {
    case 'approved':
      return { status: 'Approved', raw };
    case 'changes_requested':
      return { status: 'Requested Changes', raw };
    case '':
      return { status: approved ? 'Approved' : 'Pending', raw };
    default:
      return { status: undefined, raw };
  }
}

export function normalizePrState(state: string | null | undefined): { status: PrStatus | undefined; raw: string } {
  const raw = state ?? '';
  const upper = raw.trim().toUpperCase();
  const known: PrStatus[] = ['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED'];
  return { status: known.includes(upper as PrStatus) ? (upper as PrStatus) : undefined, raw };
}

// ---------------------------------------------------------------------------
// Row building
// ---------------------------------------------------------------------------

/** "YYYY-MM-DD HH:mm:ss" in the given IANA zone — a format Zoho Sheet recognises as a date-time. */
export function formatDateTime(iso: string | Date, timeZone: string): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return '';
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

/**
 * PR ID cell: "#123" linking to the PR. The "#" matters: Zoho criteria cannot match a hyperlink
 * whose text is purely numeric, and it lets existing plain-number cells be told apart and
 * converted once.
 */
export function prIdCell(pr: Pick<BbPullRequest, 'id' | 'links'>): CellValue {
  const text = `#${pr.id}`;
  const url = pr.links.html?.href;
  return url ? { url, text } : text;
}

export function cellText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'object' && 'text' in value) return String((value as Hyperlink).text);
  return String(value);
}

/**
 * Bitbucket-owned values for one (PR, reviewer) row. Fields whose value is unknown
 * (unrecognised state, unknown reviewer level) are omitted so existing cell values survive.
 */
export function buildSyncedFields(
  pr: BbPullRequest,
  reviewer: PrReviewer,
  reviewerLevel: string | undefined,
  timeZone: string,
): RowValues {
  const row: RowValues = {
    [COL.prId]: prIdCell(pr),
    [COL.reviewer]: reviewer.displayName,
    [COL.sourceBranch]: pr.source.branch?.name ?? '',
    [COL.targetBranch]: pr.destination.branch?.name ?? '',
    [COL.createdAt]: formatDateTime(pr.created_on, timeZone),
    [COL.updatedAt]: formatDateTime(pr.updated_on, timeZone),
  };
  if (reviewerLevel) row[COL.reviewerLevel] = reviewerLevel;
  if (reviewer.status) row[COL.reviewStatus] = reviewer.status;
  const prState = normalizePrState(pr.state);
  if (prState.status) row[COL.prStatus] = prState.status;
  return row;
}

/**
 * Columns in `desired` whose value differs from `existing`. Only SYNCED_COLUMNS are ever
 * considered, so manual columns can never leak into an update.
 */
export function diffSyncedFields(existing: Record<string, unknown>, desired: RowValues): RowValues {
  const changes: RowValues = {};
  for (const col of SYNCED_COLUMNS) {
    if (!(col in desired)) continue;
    const want = desired[col]!;
    if (!cellEquals(col, existing[col], want)) changes[col] = want;
  }
  return changes;
}

export function cellEquals(column: string, actual: unknown, expected: CellValue): boolean {
  const a = cellText(actual).trim();
  const e = cellText(expected).trim();
  if (a === e) return true;
  if (typeof actual === 'number' || typeof expected === 'number') {
    if (a !== '' && Number(a) === Number(e)) return true;
  }
  if (DATE_COLUMNS.has(column)) {
    // Zoho reads dates back in the spreadsheet's locale (e.g. "7/9/2026 1:35:33 PM" in India =
    // 7 Sep) and stores time as a float, so 5:02:56 can come back as "5:02:55.999". Treat values
    // under a minute apart as equal, under every plausible D/M vs M/D reading.
    const ca = dateCandidates(a);
    return dateCandidates(e).some((x) => ca.some((y) => Math.abs(x - y) < 60));
  }
  return false;
}

/** Wall-clock seconds for a date-time string; two candidates when D/M vs M/D is ambiguous. */
export function dateCandidates(s: string): number[] {
  const at = (y: number, mo: number, d: number, h: number, mi: number, sec: number) =>
    mo >= 1 && mo <= 12 && d >= 1 && d <= 31 ? [Date.UTC(y, mo - 1, d, h, mi) / 1000 + sec] : [];
  const time = '(?:[ T,]+(\\d{1,2}):(\\d{2})(?::(\\d{2}(?:\\.\\d+)?))?\\s*([AaPp][Mm])?)?\\s*$';
  let m = new RegExp(`^(\\d{4})[-/](\\d{1,2})[-/](\\d{1,2})${time}`).exec(s);
  if (m) {
    const [h, mi, sec] = clock(m[4], m[5], m[6], m[7]);
    return at(+m[1]!, +m[2]!, +m[3]!, h, mi, sec);
  }
  m = new RegExp(`^(\\d{1,2})[/.-](\\d{1,2})[/.-](\\d{4})${time}`).exec(s);
  if (m) {
    const [h, mi, sec] = clock(m[4], m[5], m[6], m[7]);
    return [...at(+m[3]!, +m[2]!, +m[1]!, h, mi, sec), ...at(+m[3]!, +m[1]!, +m[2]!, h, mi, sec)];
  }
  return [];
}

function clock(h?: string, mi?: string, sec?: string, ampm?: string): [number, number, number] {
  let hour = +(h ?? 0);
  const ap = ampm?.toUpperCase();
  if (ap === 'PM' && hour < 12) hour += 12;
  if (ap === 'AM' && hour === 12) hour = 0;
  return [hour, +(mi ?? 0), +(sec ?? 0)];
}

/**
 * Whole days the PR has been (or was) open: until now while OPEN, otherwise until its last
 * update. Bitbucket's PR payload has no merged/closed timestamp, so for closed PRs
 * `updated_on` is used — accurate unless someone commented after it was closed.
 */
export function daysOpen(pr: Pick<BbPullRequest, 'state' | 'created_on' | 'updated_on'>, now: Date): number {
  const start = Date.parse(pr.created_on);
  const end = normalizePrState(pr.state).status === 'OPEN' ? now.getTime() : Date.parse(pr.updated_on);
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  return Math.max(0, Math.floor((end - start) / 86_400_000));
}

// ---------------------------------------------------------------------------
// Interactive mapping (manual fields)
// ---------------------------------------------------------------------------

export interface PrMapping {
  prId: number;
  interactiveName: string;
  developer: string;
  interactiveType: string;
  phase: string;
  prLabel: string;
}

/**
 * Manual column values for a new row of `prId`, or null when the PR is unmapped.
 * Sources, in order:
 *   1. the mapping worksheet (PR ID → Interactive Name, Developer, Type, Phase, PR)
 *   2. an existing row in the main sheet for the same PR ID that has an Interactive Name
 * No fuzzy matching: if neither source has an Interactive Name, the PR is unmapped.
 */
export function resolveManualFields(
  mapping: PrMapping | undefined,
  siblingRows: Array<Record<string, unknown>>,
): RowValues | null {
  if (mapping && mapping.interactiveName.trim()) {
    return {
      [COL.developer]: mapping.developer,
      [COL.interactiveType]: mapping.interactiveType,
      [COL.interactiveName]: mapping.interactiveName,
      [COL.phase]: mapping.phase,
      [COL.pr]: mapping.prLabel,
    };
  }
  const sibling = siblingRows.find((r) => String(r[COL.interactiveName] ?? '').trim() !== '');
  if (!sibling) return null;
  const manual: RowValues = {};
  for (const col of MANUAL_COLUMNS) manual[col] = sibling[col] == null ? '' : String(sibling[col]);
  return manual;
}

/**
 * Manual columns that are blank in `existing` and have a value in `manual`. Used when a PR
 * that was inserted unmapped gets mapped later. Never returns a column that already has a
 * value, so hand-entered data is never overwritten.
 */
export function fillBlankManualFields(existing: Record<string, unknown>, manual: RowValues): RowValues {
  const fills: RowValues = {};
  for (const col of MANUAL_COLUMNS) {
    const current = existing[col] == null ? '' : String(existing[col]).trim();
    const wanted = manual[col] == null ? '' : String(manual[col]).trim();
    if (current === '' && wanted !== '') fills[col] = wanted;
  }
  return fills;
}
