/**
 * PR digest: one Cliq message per person, built from the PR Reviews rows (Queue State, Waiting On,
 * Build Drop Date, ...) and the Review Rota. Pure; no I/O.
 *
 *   as an author   - their open PRs grouped by build drop, each with what it needs next: resolve
 *                    comments, chase a reviewer (named), wait for a dependency, or merge.
 *   as a reviewer  - PRs waiting on them, grouped by build drop: fresh reviews and re-reviews.
 *
 * People are always referred to by name, never by pronoun.
 */
import { normalizeName, parsePrId } from '../sync/identity.js';
import { cellText } from '../sync/mapper.js';
import type { RotaEntry } from '../sync/queue.js';
import { parseSheetDate } from '../tracker/completion.js';

export type DigestKind = 'morning' | 'evening';

export interface Digest {
  /** Name as written in the sheet (Developer / Reviewer / Waiting On). */
  person: string;
  /** One Cliq message. When everything does not fit, the latest drops are cut and the sheet linked. */
  text: string;
  /** Open PRs authored by this person. */
  authored: number;
  /** Reviews waiting on this person. */
  reviews: number;
}

export interface DigestInput {
  /** PR Reviews rows as returned by the sheet (header -> value). */
  rows: Array<Record<string, unknown>>;
  rota: RotaEntry[];
  /** YYYY-MM-DD in the sheet's time zone. */
  today: string;
  kind: DigestKind;
  prUrl(id: number): string;
  /** Linked when a digest is too long for one message. */
  sheetUrl: string;
}

/** Cliq rejects a message text over 5000 characters ("input_maxlength_reached"); keep a margin. */
export const MAX_MESSAGE_LENGTH = 4900;

interface ReviewRow {
  reviewer: string;
  state: string;
  waitingOn: string;
  daysWaiting: number | null;
  round: string;
  commitsSince: string;
}

interface Pr {
  id: number;
  developer: string;
  interactive: string;
  /** ISO date, or null when the row has no (readable) Build Drop Date. */
  drop: string | null;
  status: string;
  queueState: string;
  mergedAt: string | null;
  rows: ReviewRow[];
}

interface Line {
  drop: string | null;
  /** Lower sorts first within a drop. */
  rank: number;
  daysWaiting: number;
  prId: number;
  text: string;
  /** Reviewer lines of the same author + interactive are merged into one line: header · item, item */
  group?: { header: string; item: string };
}

export interface Block {
  text: string;
  kind: 'fixed' | 'heading' | 'item';
  /** PRs listed in this block. */
  prs: number;
}

const FRESH = new Set(['Waiting for Review', 'Waiting for L2']);
const UNASSIGNED = 'Unassigned';
const LEGEND =
  '_🔧 action on you · 👥 follow up with the reviewer · ⛔ blocked · 🆕 fresh review · 🔁 re-review · ' +
  '2d = waiting 2 working days · +3 = new commits since the last review_';

export function planDigests(input: DigestInput): Digest[] {
  const prs = groupPrs(input.rows);
  const authored = new Map<string, Line[]>();
  const merged = new Map<string, number[]>();
  const reviews = new Map<string, Line[]>();
  const names = new Map<string, string>();
  const push = <T>(m: Map<string, T[]>, person: string, item: T) => {
    const key = normalizeName(person);
    if (!key) return;
    if (!names.has(key)) names.set(key, person.trim());
    m.set(key, [...(m.get(key) ?? []), item]);
  };

  for (const pr of prs) {
    if (pr.status === 'MERGED' && input.kind === 'evening' && pr.mergedAt === input.today) {
      push(merged, pr.developer, pr.id);
    }
    if (pr.status !== 'OPEN') continue;
    const rotaReviewers = activeRota(input.rota, pr.developer, input.today);
    const author = authorLine(pr, rotaReviewers, input.prUrl);
    if (author) push(authored, pr.developer, author);
    for (const [person, line] of reviewLines(pr, rotaReviewers, input.prUrl)) push(reviews, person, line);
  }

  const out: Digest[] = [];
  for (const [key, person] of names) {
    const mine = authored.get(key) ?? [];
    const todo = reviews.get(key) ?? [];
    const done = merged.get(key) ?? [];
    if (!mine.length && !todo.length && !done.length) continue;
    out.push({
      person,
      text: render({ person, kind: input.kind, today: input.today, mine, todo, done, prUrl: input.prUrl, sheetUrl: input.sheetUrl }),
      authored: mine.length,
      reviews: todo.length,
    });
  }
  return out.sort((a, b) => a.person.localeCompare(b.person));
}

// ---------------------------------------------------------------------------
// Rows -> PRs
// ---------------------------------------------------------------------------

function groupPrs(rows: Array<Record<string, unknown>>): Pr[] {
  const byId = new Map<number, Pr>();
  for (const v of rows) {
    const id = parsePrId(v['PR ID']);
    if (!id) continue;
    const text = (col: string) => cellText(v[col]).trim();
    let pr = byId.get(id);
    if (!pr) {
      pr = {
        id,
        developer: text('Developer'),
        interactive: text('Interactive Name').replace(/\.html?$/i, ''),
        drop: parseSheetDate(text('Build Drop Date')),
        status: text('PR Status'),
        queueState: text('PR Queue State'),
        mergedAt: parseSheetDate(text('Merged At')),
        rows: [],
      };
      byId.set(id, pr);
    }
    const days = Number(text('Days Waiting'));
    pr.rows.push({
      reviewer: text('Reviewer'),
      state: text('Queue State'),
      waitingOn: text('Waiting On'),
      daysWaiting: text('Days Waiting') === '' || Number.isNaN(days) ? null : days,
      round: text('Review Round'),
      commitsSince: text('Commits Since Review'),
    });
  }
  return [...byId.values()];
}

/** Rota reviewers covering this developer today (the sync already applied the rota to Queue State). */
function activeRota(rota: RotaEntry[], developer: string, today: string): string[] {
  const dev = normalizeName(developer);
  const row = rota.find((r) => normalizeName(r.developer) === dev && r.from <= today && (!r.to || today <= r.to));
  return row?.reviewers.filter((r) => normalizeName(r) !== dev) ?? [];
}

// ---------------------------------------------------------------------------
// Author: what each open PR needs next
// ---------------------------------------------------------------------------

function authorLine(pr: Pr, rotaReviewers: string[], prUrl: (id: number) => string): Line | null {
  if (!pr.developer) return null;
  const inState = (state: string) => pr.rows.filter((r) => r.state === state && r.waitingOn !== UNASSIGNED);
  const changes = inState('Changes Requested');
  const fresh = inState('Waiting for Review');
  const rereview = inState('Waiting for Re-review');
  const l2 = inState('Waiting for L2');
  const unassigned = pr.rows.find((r) => r.waitingOn === UNASSIGNED);

  const clauses: string[] = [];
  if (changes.length) {
    clauses.push(`${withDays(changes, (r) => r.reviewer)} requested changes. Resolve the comments and push the fixes`);
  }
  if (fresh.length) {
    clauses.push(`Please connect with ${withDays(fresh, (r) => r.waitingOn)} to get it reviewed`);
  }
  if (unassigned) {
    clauses.push(
      rotaReviewers.length
        ? `No reviewer has picked it up yet${days(unassigned.daysWaiting)}. Please connect with ${list(rotaReviewers)} from the review rota`
        : `No reviewer has picked it up yet${days(unassigned.daysWaiting)}. Please ask a peer to review it`,
    );
  }
  if (rereview.length) {
    clauses.push(`Please follow up with ${withDays(rereview, (r) => r.waitingOn)} for the re-review`);
  }
  if (l2.length) {
    clauses.push(`L1 approved. Please connect with ${list(uniq(l2.map((r) => r.waitingOn)), 'or')}${days(maxDays(l2))} for the L2 review`);
  }

  const blocked = pr.queueState === 'Blocked by Dependency';
  if (!clauses.length) {
    const dependency = pr.rows.find((r) => r.state === 'Blocked by Dependency')?.waitingOn;
    if (blocked) clauses.push(`Approved, waiting for ${dependency || 'a dependency'} to merge first`);
    else if (pr.queueState === 'Approved') clauses.push('All approvals in. Ready to merge');
    else if (pr.queueState === 'Draft') clauses.push('Still a draft. Publish it when it is ready for review');
    else return null; // not synced yet, or nothing anyone can act on
  }

  const onAuthor = changes.length > 0 || pr.queueState === 'Approved' || pr.queueState === 'Draft';
  const icon = onAuthor ? '🔧' : blocked && !fresh.length && !rereview.length && !l2.length && !unassigned ? '⛔' : '👥';
  const title = `${icon} ${link(pr, prUrl)}${pr.interactive ? ` ${pr.interactive}` : ''}`;
  return {
    drop: pr.drop,
    rank: icon === '🔧' ? 0 : icon === '👥' ? 1 : 2,
    daysWaiting: maxDays(pr.rows) ?? 0,
    prId: pr.id,
    text: [title, ...clauses.map((c) => `      ↳ ${c}`)].join('\n'),
  };
}

// ---------------------------------------------------------------------------
// Reviewer: fresh reviews and re-reviews waiting on each person
// ---------------------------------------------------------------------------

function reviewLines(pr: Pr, rotaReviewers: string[], prUrl: (id: number) => string): Array<[string, Line]> {
  const out: Array<[string, Line]> = [];
  const dev = normalizeName(pr.developer);
  const seen = new Set<string>();
  const add = (person: string, rank: number, r: ReviewRow, extra: string[]) => {
    const key = normalizeName(person);
    if (!key || key === dev || seen.has(key)) return;
    seen.add(key);
    const header = [`${rank === 0 ? '🆕' : '🔁'} ${pr.developer || 'unknown author'}`, ...(pr.interactive ? [pr.interactive] : [])].join(' · ');
    const item = [link(pr, prUrl), ...extra, ...(r.daysWaiting === null ? [] : [dayCount(r.daysWaiting)])].join(' ');
    out.push([
      person,
      { drop: pr.drop, rank, daysWaiting: r.daysWaiting ?? 0, prId: pr.id, text: `${header} · ${item}`, group: { header, item } },
    ]);
  };

  for (const r of pr.rows) {
    if (r.waitingOn === UNASSIGNED) {
      for (const person of rotaReviewers) add(person, 0, r, ['(unassigned, on the rota)']);
    } else if (FRESH.has(r.state)) {
      add(r.waitingOn, 0, r, r.state === 'Waiting for L2' ? ['L2'] : []);
    } else if (r.state === 'Waiting for Re-review') {
      const commits = Number(r.commitsSince);
      add(r.waitingOn, 1, r, commits > 0 ? [`+${commits}`] : []);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render(m: {
  person: string;
  kind: DigestKind;
  today: string;
  mine: Line[];
  todo: Line[];
  done: number[];
  prUrl: (id: number) => string;
  sheetUrl: string;
}): string {
  const first = m.person.split(' ')[0] ?? m.person;
  const blocks: Block[] = [
    {
      kind: 'fixed',
      prs: 0,
      text:
        m.kind === 'morning'
          ? `☀️ *Good morning, ${first}.* PR digest for ${dayLabel(m.today)}`
          : `🌙 *End of day, ${first}.* PR digest for ${dayLabel(m.today)}`,
    },
  ];
  if (m.done.length) {
    const links = m.done.sort((a, b) => a - b).map((id) => `[#${id}](${m.prUrl(id)})`);
    blocks.push({ kind: 'fixed', prs: 0, text: `\n✅ *Merged today:* ${links.join(', ')}` });
  }
  if (m.mine.length) {
    blocks.push({ kind: 'heading', prs: 0, text: `\n*Your open PRs* (${m.mine.length})` }, ...byDrop(m.mine, m.today));
  }
  if (m.todo.length) {
    blocks.push({ kind: 'heading', prs: 0, text: `\n*Reviews waiting on you* (${m.todo.length})` }, ...byDrop(m.todo, m.today));
  }
  const legend = m.mine.length || m.todo.length ? `\n\n${LEGEND}` : '';
  return fit(blocks, legend, m.sheetUrl);
}

/**
 * Joins the blocks into one message of at most MAX_MESSAGE_LENGTH characters. Blocks are in priority
 * order (soonest drop first), so when too long the last ones are cut and the sheet is linked instead.
 */
export function fit(blocks: Block[], footer: string, sheetUrl: string): string {
  const kept = [...blocks];
  let cut = 0;
  const join = () => {
    const more = cut ? `\n\n…and ${cut} more PR${cut === 1 ? '' : 's'} in the [PR Reviews sheet](${sheetUrl})` : '';
    return kept.map((b) => b.text).join('\n') + more + footer;
  };
  while (join().length > MAX_MESSAGE_LENGTH) {
    let last = kept.length - 1;
    while (last >= 0 && kept[last]!.kind !== 'item') last--;
    if (last < 0) break;
    cut += kept[last]!.prs;
    kept.splice(last, 1);
    // Drop headings left with nothing under them.
    while (kept.length && kept.at(-1)!.kind === 'heading') kept.pop();
  }
  return join();
}

function byDrop(items: Line[], today: string): Block[] {
  const groups = new Map<string, Line[]>();
  for (const item of items) groups.set(item.drop ?? '', [...(groups.get(item.drop ?? '') ?? []), item]);
  const keys = [...groups.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));
  const out: Block[] = [];
  for (const key of keys) {
    out.push({ kind: 'heading', prs: 0, text: `📦 *${dropLabel(key || null, today)}*` });
    const sorted = groups.get(key)!.sort((a, b) => a.rank - b.rank || b.daysWaiting - a.daysWaiting || a.prId - b.prId);
    // Merge grouped lines (same header) at the position of their most urgent member.
    const merged = new Map<string, Line[]>();
    for (const line of sorted) {
      const k = line.group ? `${line.rank}|${line.group.header}` : `pr|${line.prId}`;
      merged.set(k, [...(merged.get(k) ?? []), line]);
    }
    for (const lines of merged.values()) {
      const g = lines[0]!.group;
      const text = g ? `${g.header} · ${lines.map((l) => l.group!.item).join(', ')}` : lines[0]!.text;
      out.push({ kind: 'item', prs: lines.length, text });
    }
  }
  return out;
}

export function dropLabel(drop: string | null, today: string): string {
  if (!drop) return 'No build drop date (set the Interactive Name on the PR)';
  if (drop < today) return `⚠️ Build drop was ${dayLabel(drop)}, still open`;
  if (drop === today) return `Build drop today, ${dayLabel(drop)}`;
  const n = workingDaysUntil(today, drop);
  return `Build drop ${dayLabel(drop)}, in ${n} working day${n === 1 ? '' : 's'}`;
}

/** Mon–Fri days after `from` up to and including `to` (both YYYY-MM-DD). */
export function workingDaysUntil(from: string, to: string): number {
  let n = 0;
  for (let d = Date.parse(`${from}T00:00:00Z`) + 86_400_000; d <= Date.parse(`${to}T00:00:00Z`); d += 86_400_000) {
    const dow = new Date(d).getUTCDay();
    if (dow !== 0 && dow !== 6) n++;
  }
  return n;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 2026-09-29 -> "Tue 29 Sep" */
function dayLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function link(pr: Pr, prUrl: (id: number) => string): string {
  return `[#${pr.id}](${prUrl(pr.id)})`;
}

function uniq(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((v) => {
    const k = normalizeName(v);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** "Asha", "Asha and Ravi", "Asha, Ravi and Meena" */
function list(names: string[], joiner = 'and'): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} ${joiner} ${names.at(-1)}`;
}

/** "Asha (2d) and Ravi (today)" */
function withDays(rows: ReviewRow[], name: (r: ReviewRow) => string): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const r of rows) {
    const n = name(r);
    if (!n || seen.has(normalizeName(n))) continue;
    seen.add(normalizeName(n));
    parts.push(`${n}${r.daysWaiting === null ? '' : ` (${dayCount(r.daysWaiting)})`}`);
  }
  return list(parts);
}

function maxDays(rows: ReviewRow[]): number | null {
  const d = rows.map((r) => r.daysWaiting).filter((x): x is number => x !== null);
  return d.length ? Math.max(...d) : null;
}

function days(n: number | null): string {
  return n === null ? '' : ` (${dayCount(n)})`;
}

function dayCount(n: number): string {
  return n === 0 ? 'today' : `${n}d`;
}
