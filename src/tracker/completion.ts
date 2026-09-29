/**
 * INTERACTIVE_COMPLETION planning: one row per interactive whose Build Drop date is today or later,
 * showing how far its Jira phase tasks are and whether it will be complete by the drop. Pure; no I/O.
 *
 * Column ownership:
 *   synced  - rewritten from Static Interactives / Jira on every run
 *   manual  - typed by people; never written by the sync
 *   formula - written once when the row is inserted
 */

export const COMPLETION_COLUMNS = [
  'Interactive', // A  synced (Static Interactives)
  'Developer', // B  synced (Static Interactives)
  'Ticket', // C  synced: row identity
  'Build Drop Date', // D  synced (Static Interactives)
  'Phases Done', // E  synced: "5 of 8"
  'Total SP', // F  synced (Jira)
  'Done SP', // G  synced (Jira: phases Done/Closed)
  'Remaining SP', // H  synced
  'SP / Day', // I  manual: this developer's capacity; blank = SP_PER_DAY
  'Work Days Left', // J  formula
  'Forecast Completion', // K  formula: counts the developer's whole load due by this drop
  'Completed On', // L  synced: when the last phase task was resolved
  'On Time', // M  formula
] as const;
export type CompletionColumn = (typeof COMPLETION_COLUMNS)[number];

export const SYNCED: readonly CompletionColumn[] = [
  'Interactive',
  'Developer',
  'Ticket',
  'Build Drop Date',
  'Phases Done',
  'Total SP',
  'Done SP',
  'Remaining SP',
  'Completed On',
];
const DATE_COLUMNS: readonly CompletionColumn[] = ['Build Drop Date', 'Forecast Completion', 'Completed On'];
/** Formula columns that show a date; the sheet needs a date format on them before the formula lands. */
export const DATE_FORMULA_COLUMNS: readonly CompletionColumn[] = ['Forecast Completion'];
/** Default SP a developer completes per working day. */
export const SP_PER_DAY = 5;
/** Last row the load formula looks at; keeps the ranges finite. */
const MAX_ROW = 1000;

export type Row = Partial<Record<CompletionColumn, string>>;

export interface Interactive {
  rowIndex: number;
  ticket: string;
  /** As written in Static Interactives, e.g. GEO_51319_1.html */
  name: string;
  developer: string;
  status: string;
  /** ISO date */
  drop: string;
}

export interface PhaseTask {
  status: string;
  storyPoints: number | null;
  /** ISO date-time the task was resolved, or null. */
  resolvedAt: string | null;
}

export interface CompletionRow {
  rowIndex: number;
  values: Row;
}

export type CompletionOp = { kind: 'insert'; values: Row } | { kind: 'update'; rowIndex: number; changes: Row };

const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Dates as Zoho returns them: `d/m/yyyy` (the sheet's locale), `d-Mon-yyyy`, ISO, or a date serial,
 * optionally followed by a time. Returns ISO YYYY-MM-DD, or null.
 */
export function parseSheetDate(raw: unknown): string | null {
  const s = String(raw ?? '').trim().split(/[ T]/)[0]!;
  if (!s) return null;
  let y: number, m: number, d: number;
  let match: RegExpMatchArray | null;
  if ((match = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) {
    [d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else if ((match = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) {
    [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else if ((match = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/))) {
    const mi = MONTHS.findIndex((x) => x.toLowerCase() === match![2]!.toLowerCase());
    if (mi < 0) return null;
    [d, m, y] = [Number(match[1]), mi + 1, Number(match[3])];
  } else if (/^\d{5}$/.test(s)) {
    return new Date(EXCEL_EPOCH_MS + Number(s) * 86_400_000).toISOString().slice(0, 10);
  } else {
    return null;
  }
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

/** ISO date → `d-Mon-yyyy`, which Zoho stores as a date and reads back unchanged. */
export function sheetDate(iso: string): string {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${d}-${MONTHS[m! - 1]}-${y}`;
}

const isClosed = (status: string) => /^(done|closed)$/i.test(status);

/**
 * Interactive status from its Jira phase tasks, in the sheet's wording. Done only when every task
 * is Done/Closed; To do only when none has started.
 */
export function rollupStatus(taskStatuses: string[]): string {
  if (!taskStatuses.length) return '';
  if (taskStatuses.every(isClosed)) return 'Done';
  if (taskStatuses.every((s) => /^to do$/i.test(s))) return 'To do';
  return 'In progress';
}

/** Synced values for one interactive. */
export function completionValues(i: Interactive, tasks: PhaseTask[]): Row {
  const sp = (t: PhaseTask) => t.storyPoints ?? 0;
  const closed = tasks.filter((t) => isClosed(t.status));
  const total = tasks.reduce((s, t) => s + sp(t), 0);
  const done = closed.reduce((s, t) => s + sp(t), 0);
  const complete = tasks.length > 0 && closed.length === tasks.length;
  const lastResolved = closed.map((t) => t.resolvedAt ?? '').sort().at(-1) ?? '';
  return {
    Interactive: i.name,
    Developer: i.developer,
    Ticket: i.ticket,
    'Build Drop Date': sheetDate(i.drop),
    'Phases Done': `${closed.length} of ${tasks.length}`,
    'Total SP': String(total),
    'Done SP': String(done),
    'Remaining SP': String(total - done),
    'Completed On': complete ? sheetDate(lastResolved) : '',
  };
}

/** Formulas for a newly inserted row (row number r). `;` separators, and never `+` (see sync.ts). */
export function rowFormulas(r: number): Row {
  const range = (c: string) => `$${c}$2:$${c}$${MAX_ROW}`;
  const rate = `IF(I${r}="";${SP_PER_DAY};I${r})`;
  // Remaining SP of every interactive this developer has due on or before this drop.
  const load = `SUMIFS(${range('H')};${range('B')};B${r};${range('D')};"<="&D${r})`;
  return {
    'Work Days Left': `=IF(D${r}="";"";MAX(0;NETWORKDAYS(TODAY();D${r})))`,
    'Forecast Completion': `=IF(OR(L${r}<>"";H${r}=0;D${r}="");"";WORKDAY(TODAY()-1;ROUNDUP(${load}/${rate};0)))`,
    'On Time':
      `=IF(L${r}<>"";IF(L${r}<=D${r};"Done";"Done late");IF(D${r}="";"";IF(D${r}<TODAY();"Missed";` +
      `IF(F${r}=0;"No SP";IF(H${r}=0;"On track";IF(K${r}<=D${r};"On track";"At risk"))))))`,
  };
}

/** Inserts and updates for the due interactives. Rows of other interactives are never touched. */
export function planCompletion(input: {
  due: Interactive[];
  tasks: Map<string, PhaseTask[]>;
  existing: CompletionRow[];
}): CompletionOp[] {
  const byTicket = new Map(input.existing.map((r) => [(r.values.Ticket ?? '').trim(), r]));
  const ops: CompletionOp[] = [];
  for (const i of input.due) {
    const tasks = input.tasks.get(i.ticket);
    if (!tasks?.length) continue;
    const desired = completionValues(i, tasks);
    const row = byTicket.get(i.ticket);
    if (!row) {
      ops.push({ kind: 'insert', values: desired });
      continue;
    }
    const changes: Row = {};
    for (const col of SYNCED) {
      if (!sameCell(col, row.values[col] ?? '', desired[col] ?? '')) changes[col] = desired[col] ?? '';
    }
    if (Object.keys(changes).length) ops.push({ kind: 'update', rowIndex: row.rowIndex, changes });
  }
  return ops;
}

function sameCell(col: CompletionColumn, actual: string, want: string): boolean {
  const a = actual.trim();
  if (a === want.trim()) return true;
  if (DATE_COLUMNS.includes(col)) return parseSheetDate(a) === parseSheetDate(want);
  if (a !== '' && want !== '' && !Number.isNaN(Number(a))) return Number(a) === Number(want);
  return false;
}
