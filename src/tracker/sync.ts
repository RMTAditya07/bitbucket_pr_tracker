import type { Config } from '../config/env.js';
import type { JiraClient } from '../jira/client.js';
import type { Logger } from '../logger/logger.js';
import { cellText, formatDateTime } from '../sync/mapper.js';
import { ZohoApiError, type ZohoClient } from '../zoho/client.js';
import {
  COMPLETION_COLUMNS,
  DATE_FORMULA_COLUMNS,
  parseSheetDate,
  planCompletion,
  rollupStatus,
  rowFormulas,
  type CompletionColumn,
  type CompletionRow,
  type Interactive,
  type PhaseTask,
  type Row,
} from './completion.js';

const FETCH_PAGE_SIZE = 1000;
const HEADER_SCAN_COLUMNS = 40;
const ZOHO_SHEET_NOT_FOUND = 2863;
/** Typed into a cell before its formula so Zoho gives the cell a date format (no API sets one). */
const DATE_SEED = '1-Jan-2026';

export interface TrackerSyncSummary {
  due: number;
  statusesUpdated: number;
  inserted: number;
  updated: number;
}

/**
 * For every interactive whose Build Drop date (Static Interactives) is today or later:
 *   - Static Interactives Status   <- rolled up from its Jira phase tasks
 *   - INTERACTIVE_COMPLETION row   <- phases done, SP done/remaining, completion date
 *
 * Zoho quirks: a `+` inside a formula reaches Zoho as a space, and no API sets a number format, so
 * formulas avoid `+` and date formula cells are seeded with a date first. `worksheet.csvdata.set`
 * ignores its row on tabs Zoho treats as tables (Static Interactives), so existing cells are written
 * one at a time with `cell.content.set`; csvdata only appends new rows.
 */
export async function runTrackerSync(
  zoho: ZohoClient,
  jira: Pick<JiraClient, 'linkedTasks' | 'tasks'>,
  config: { tracker: Config['tracker']; timeZone: string },
  logger: Logger,
  now = new Date(),
): Promise<TrackerSyncSummary> {
  const today = formatDateTime(now, config.timeZone).slice(0, 10);
  const source = config.tracker.buildSourceWorksheetName;

  // 1. Due interactives
  const due: Interactive[] = [];
  for (const v of await fetchRecords(zoho, source)) {
    const ticket = cellText(v['Ticket']).trim();
    const drop = parseSheetDate(v['Build Drop date'] ?? v['Build Drop Date']);
    if (!/^[A-Z]+-\d+$/.test(ticket) || !drop || drop < today) continue;
    due.push({
      rowIndex: Number(v['row_index']),
      ticket,
      name: cellText(v['Interactive Name']).trim(),
      developer: cellText(v['Developer']).trim(),
      status: cellText(v['Status']).trim(),
      drop,
    });
  }
  logger.event('info', 'TRACKER_DUE', { today, interactives: due.length });
  if (!due.length) return { due: 0, statusesUpdated: 0, inserted: 0, updated: 0 };

  // 2. Jira phase tasks per interactive
  const links = await jira.linkedTasks(due.map((i) => i.ticket));
  const found = await jira.tasks([...new Set([...links.values()].flat())]);
  const tasks = new Map<string, PhaseTask[]>();
  for (const i of due) {
    const phase = (links.get(i.ticket) ?? []).flatMap((k) => found.get(k) ?? []);
    if (phase.length) tasks.set(i.ticket, phase);
    else logger.event('warn', 'NO_PHASE_TASKS', { ticket: i.ticket, interactive: i.name });
  }

  // 3. Static Interactives Status
  let statusesUpdated = 0;
  const statusColumn = (await headerColumns(zoho, source))('Status');
  for (const i of due) {
    const status = rollupStatus((tasks.get(i.ticket) ?? []).map((t) => t.status));
    if (!status || status === i.status) continue;
    logger.event('info', 'STATUS_CHANGED', { interactive: i.name, from: i.status, to: status });
    await setCell(zoho, source, i.rowIndex, statusColumn, status);
    statusesUpdated++;
  }

  // 4. INTERACTIVE_COMPLETION
  const tab = config.tracker.completionWorksheetName;
  const existing = await readCompletion(zoho, tab, logger);
  const ops = planCompletion({ due, tasks, existing });

  const inserts = ops.flatMap((o) => (o.kind === 'insert' ? [o.values] : []));
  if (inserts.length) {
    // New rows go directly below the last one (csvdata appends there even on table-like tabs).
    // Date formula cells are first written as a date, then replaced by their formula in place, so
    // they keep a date format.
    const first = Math.max(1, ...existing.map((r) => r.rowIndex)) + 1;
    const rows = inserts.map((values, n) => ({ ...values, ...rowFormulas(first + n) }));
    const seeded = rows.map((r) => ({ ...r, ...Object.fromEntries(DATE_FORMULA_COLUMNS.map((c) => [c, DATE_SEED])) }));
    await appendCsv(
      zoho,
      tab,
      first,
      1,
      seeded.map((r) => COMPLETION_COLUMNS.map((c) => csvCell(r[c] ?? '')).join(',')),
    );
    for (const [n, r] of rows.entries()) {
      for (const col of DATE_FORMULA_COLUMNS) await setCell(zoho, tab, first + n, colIndex(col), r[col] ?? '');
    }
    for (const r of inserts) logger.event('info', 'COMPLETION_INSERT', { interactive: r.Interactive });
  }
  for (const op of ops) {
    if (op.kind !== 'update') continue;
    logger.event('info', 'COMPLETION_UPDATE', { row: op.rowIndex, columns: Object.keys(op.changes).join(', ') });
    for (const [col, value] of Object.entries(op.changes) as Array<[CompletionColumn, string]>) {
      await setCell(zoho, tab, op.rowIndex, colIndex(col), value);
    }
  }
  return { due: due.length, statusesUpdated, inserted: inserts.length, updated: ops.length - inserts.length };
}

/** Reads the completion tab, creating it (header row) when it does not exist yet. */
async function readCompletion(zoho: ZohoClient, name: string, logger: Logger): Promise<CompletionRow[]> {
  try {
    return (await fetchRecords(zoho, name)).map((v) => ({
      rowIndex: Number(v['row_index']),
      values: Object.fromEntries(COMPLETION_COLUMNS.map((c) => [c, cellText(v[c])])) as Row,
    }));
  } catch (err) {
    if (!(err instanceof ZohoApiError) || err.code !== ZOHO_SHEET_NOT_FOUND) throw err;
  }
  logger.event('info', 'COMPLETION_TAB_CREATED', { worksheet: name });
  await zoho.call({ method: 'worksheet.insert', worksheet_name: name });
  await appendCsv(zoho, name, 1, 1, [COMPLETION_COLUMNS.map(csvCell).join(',')]);
  const sp = colLetter('SP / Day');
  await zoho.call({
    method: 'ranges.format.set',
    format_json: JSON.stringify([
      { worksheet_name: name, range: `A1:${colLetter('On Time')}1`, bold: true, fill_color: '#1F3864', font_color: '#FFFFFF' },
      { worksheet_name: name, range: `${sp}2:${sp}1000`, fill_color: '#FFF2CC' },
    ]),
  });
  return [];
}

async function fetchRecords(zoho: ZohoClient, worksheetName: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (let start = 1; ; start += FETCH_PAGE_SIZE) {
    const res = await zoho.call<{ records?: Record<string, unknown>[] }>({
      method: 'worksheet.records.fetch',
      worksheet_name: worksheetName,
      header_row: '1',
      records_start_index: String(start),
      count: String(FETCH_PAGE_SIZE),
    });
    const records = res.records ?? [];
    out.push(...records);
    if (records.length < FETCH_PAGE_SIZE) return out;
  }
}

/** Writes CSV lines starting at (row, column). Only used for new rows below the last one. */
async function appendCsv(zoho: ZohoClient, worksheetName: string, row: number, column: number, lines: string[]) {
  await zoho.call({
    method: 'worksheet.csvdata.set',
    worksheet_name: worksheetName,
    row: String(row),
    column: String(column),
    data: lines.join('\n'),
  });
}

/** One existing cell. cell.content.set rejects empty content, so a blank is a range clear. */
async function setCell(zoho: ZohoClient, worksheetName: string, row: number, column: number, content: string) {
  if (content === '') {
    const at = { start_row: String(row), start_column: String(column), end_row: String(row), end_column: String(column) };
    await zoho.call({ method: 'range.content.clear', worksheet_name: worksheetName, ...at });
    return;
  }
  await zoho.call({
    method: 'cell.content.set',
    worksheet_name: worksheetName,
    row: String(row),
    column: String(column),
    content,
  });
}

function colIndex(col: CompletionColumn): number {
  return COMPLETION_COLUMNS.indexOf(col) + 1;
}

function colLetter(col: CompletionColumn): string {
  return String.fromCharCode(64 + colIndex(col));
}

/** Resolves a header name in row 1 to its 1-based column index. */
async function headerColumns(zoho: ZohoClient, worksheetName: string): Promise<(header: string) => number> {
  const res = await zoho.call<{
    range_details?: Array<{ row_details?: Array<{ column_index: number; content?: string }> }>;
  }>({
    method: 'range.content.get',
    worksheet_name: worksheetName,
    start_row: '1',
    start_column: '1',
    end_row: '1',
    end_column: String(HEADER_SCAN_COLUMNS),
  });
  const cells = res.range_details?.[0]?.row_details ?? [];
  return (header) => {
    const cell = cells.find((c) => c.content?.trim() === header);
    if (!cell) throw new Error(`"${header}" header not found in row 1 of worksheet "${worksheetName}"`);
    return cell.column_index;
  };
}

function csvCell(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
