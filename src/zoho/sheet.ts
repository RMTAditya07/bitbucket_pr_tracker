import type { Config } from '../config/env.js';
import type { Logger } from '../logger/logger.js';
import { parsePrId } from '../sync/identity.js';
import { COL, SHEET_COLUMNS, dateCandidates, type CellValue, type PrMapping, type RowValues } from '../sync/mapper.js';
import type { InteractiveEntry } from '../sync/interactives.js';
import type { RotaEntry } from '../sync/queue.js';
import type { ReviewerLevel, RowMatch, SheetRow, SheetStore } from '../sync/synchronizer.js';
import { ZohoApiError, type ZohoClient } from './client.js';

const FETCH_PAGE_SIZE = 1000; // Zoho returns at most 1000 records per fetch
const INSERT_BATCH_SIZE = 50;
const ZOHO_SHEET_NOT_FOUND = 2863;

interface FetchResponse {
  records?: Array<Record<string, unknown> & { row_index?: number }>;
}

/** Zoho Sheet "tabular data" API: the worksheet's first row is the header. */
export class ZohoSheetStore implements SheetStore {
  private checkedHeaders = false;
  private headerColumns: Set<string> | null = null;

  constructor(
    private readonly client: ZohoClient,
    private readonly config: Config['zoho'],
    private readonly logger: Logger,
  ) {}

  async readRows(): Promise<SheetRow[]> {
    const rows = await this.fetchAll(this.config.worksheetName);
    // Zoho returns every header column on every record (blank cells included).
    this.headerColumns = rows.length > 0 ? new Set(rows.flatMap((r) => Object.keys(r.values))) : null;
    if (!this.checkedHeaders && this.headerColumns) {
      this.checkedHeaders = true;
      const present = this.headerColumns;
      const missing = SHEET_COLUMNS.filter((c) => !present.has(c));
      if (missing.length) {
        this.logger.event('warn', 'SHEET_COLUMNS_MISSING', {
          worksheet: this.config.worksheetName,
          missing: missing.join(', '),
          note: 'Add these header cells exactly as spelled; until then they are not written.',
        });
      }
    }
    return rows;
  }

  columns(): Set<string> | null {
    return this.headerColumns;
  }

  async readPrMappings(): Promise<PrMapping[]> {
    if (!this.config.mappingWorksheetName) return [];
    const rows = await this.fetchOptional(this.config.mappingWorksheetName, 'ZOHO_MAPPING_WORKSHEET_NAME');
    const out: PrMapping[] = [];
    for (const { values: v } of rows) {
      const prId = parsePrId(v['PR ID']);
      if (!prId) continue;
      out.push({
        prId,
        interactiveName: str(v[COL.interactiveName]),
        developer: str(v[COL.developer]),
        interactiveType: str(v[COL.interactiveType]),
        phase: str(v[COL.phase]),
        prLabel: str(v[COL.pr]),
        dependsOn: str(v[COL.dependsOn]),
      });
    }
    return out;
  }

  async readReviewerLevels(): Promise<ReviewerLevel[]> {
    if (!this.config.reviewerLevelsWorksheetName) return [];
    const rows = await this.fetchOptional(
      this.config.reviewerLevelsWorksheetName,
      'ZOHO_REVIEWER_LEVELS_WORKSHEET_NAME',
    );
    return rows
      .map(({ values: v }) => ({
        reviewerId: str(v['Reviewer ID']) || null,
        reviewerName: str(v['Reviewer']),
        level: str(v['Level']),
      }))
      .filter((l) => l.level && (l.reviewerId || l.reviewerName));
  }

  /**
   * Review Rota: Developer | L1 Reviewer 1 | L1 Reviewer 2 | From | To. Every column whose header
   * contains the word "Reviewer" is a reviewer. Rows without a readable From date are skipped: an open
   * start would pull every existing PR into rota mode.
   */
  async readReviewRota(): Promise<RotaEntry[]> {
    if (!this.config.reviewRotaWorksheetName) return [];
    const rows = await this.fetchOptional(this.config.reviewRotaWorksheetName, 'ZOHO_REVIEW_ROTA_WORKSHEET_NAME');
    const out: RotaEntry[] = [];
    for (const { rowIndex, values: v } of rows) {
      const developer = str(v[COL.developer]);
      if (!developer) continue;
      const reviewers = Object.entries(v)
        .filter(([k, x]) => /\breviewer\b/i.test(k) && str(x))
        .map(([, x]) => str(x));
      const from = toIsoDate(str(v['From']));
      const to = toIsoDate(str(v['To']));
      if (!from) {
        this.logger.event('warn', 'ROTA_ROW_SKIPPED', {
          worksheet: this.config.reviewRotaWorksheetName,
          row: rowIndex,
          developer,
          note: 'From date missing or unreadable (use YYYY-MM-DD).',
        });
        continue;
      }
      out.push({ developer, reviewers, from, to });
    }
    return out;
  }

  async readInteractives(): Promise<InteractiveEntry[]> {
    const out: InteractiveEntry[] = [];
    for (const ws of this.config.interactiveWorksheetNames) {
      const rows = await this.fetchOptional(ws, 'ZOHO_INTERACTIVE_WORKSHEETS');
      for (const { values: v } of rows) {
        const name = str(v[COL.interactiveName]);
        if (!name) continue;
        const buildDrop = str(v['Build Drop date'] ?? v['Build Drop Date']);
        out.push({ name, type: str(v[COL.interactiveType]), buildDrop });
      }
    }
    return out;
  }

  async insertRows(rows: RowValues[]): Promise<void> {
    for (let i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
      await this.call(this.config.worksheetName, {
        method: 'worksheet.records.add',
        header_row: '1',
        json_data: JSON.stringify(rows.slice(i, i + INSERT_BATCH_SIZE).map(toZohoRow)),
      });
    }
  }

  async updateRows(match: RowMatch, values: RowValues): Promise<void> {
    await this.call(this.config.worksheetName, {
      method: 'worksheet.records.update',
      header_row: '1',
      criteria: buildCriteria(match),
      data: JSON.stringify(toZohoRow(values)),
      // Keyed updates touch every copy so accidental duplicates stay consistent;
      // legacy adoption must claim exactly one row.
      first_match_only: 'syncKey' in match ? 'false' : 'true',
    });
  }

  /** Optional worksheets: a missing tab is a warning, not a reason to abort the sync. */
  private async fetchOptional(worksheetName: string, envVar: string): Promise<SheetRow[]> {
    try {
      return await this.fetchAll(worksheetName);
    } catch (err) {
      if (!(err instanceof ZohoApiError) || err.code !== ZOHO_SHEET_NOT_FOUND) throw err;
      this.logger.event('warn', 'WORKSHEET_NOT_FOUND', {
        worksheet: worksheetName,
        note: `Create a tab with this exact name, or clear ${envVar} in .env. Continuing without it.`,
      });
      return [];
    }
  }

  private async fetchAll(worksheetName: string): Promise<SheetRow[]> {
    const rows: SheetRow[] = [];
    for (let start = 1; ; start += FETCH_PAGE_SIZE) {
      const res = await this.call<FetchResponse>(worksheetName, {
        method: 'worksheet.records.fetch',
        header_row: '1',
        records_start_index: String(start),
        count: String(FETCH_PAGE_SIZE),
      });
      const records = res.records ?? [];
      for (const { row_index, ...values } of records) {
        rows.push({ rowIndex: Number(row_index ?? -1), values });
      }
      if (records.length < FETCH_PAGE_SIZE) return rows;
    }
  }

  /** Adds the worksheet name to Zoho errors ("The sheet does not exists" alone is ambiguous). */
  private async call<T = Record<string, unknown>>(worksheetName: string, params: Record<string, string>): Promise<T> {
    try {
      return await this.client.call<T>({ ...params, worksheet_name: worksheetName });
    } catch (err) {
      if (err instanceof ZohoApiError) {
        throw new ZohoApiError(`${err.message} [worksheet "${worksheetName}"]`, err.code);
      }
      throw err;
    }
  }
}

/** Zoho criteria syntax: "Column"="text" / "Column"=123, joined with `and`. */
export function buildCriteria(match: RowMatch): string {
  if ('syncKey' in match) return `"${COL.syncKey}"=${quote(match.syncKey)}`;
  const { prId, reviewerName } = match.legacy;
  return `"${COL.prId}"=${prId} and "${COL.reviewer}"=${quote(reviewerName)}`;
}

function quote(value: string): string {
  if (value.includes('"')) throw new Error(`Cannot use a value containing '"' in Zoho criteria: ${value}`);
  return `"${value}"`;
}

/** Hyperlinks become =HYPERLINK formulas (verified: Zoho evaluates formulas sent via records.add/update). */
export function toZohoRow(values: RowValues): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [col, v] of Object.entries(values)) out[col] = toZohoCell(v);
  return out;
}

function toZohoCell(v: CellValue): string | number {
  if (typeof v !== 'object') return v;
  const esc = (s: string) => s.replace(/"/g, '""');
  return `=HYPERLINK("${esc(v.url)}","${esc(v.text)}")`;
}

/** A date cell as YYYY-MM-DD. Ambiguous D/M vs M/D reads day-first (Indian locale). */
export function toIsoDate(value: string): string | null {
  const [first] = dateCandidates(value);
  return first === undefined ? null : new Date(first * 1000).toISOString().slice(0, 10);
}

function str(v: unknown): string {
  return v == null ? '' : String(v).trim();
}
