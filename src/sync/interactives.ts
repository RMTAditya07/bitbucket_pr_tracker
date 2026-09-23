/**
 * Deterministic interactive detection: find a known Interactive Name (from the interactives
 * worksheets) inside a PR's branch, title or description. Exact name match only — no fuzzy
 * matching — and only when exactly one interactive is named.
 */

export interface InteractiveEntry {
  name: string;
  type: string;
  /** Build Drop date as shown in the interactives worksheet ('' when not set). */
  buildDrop?: string;
}

export type DetectionSource = 'branch' | 'title' | 'description';

export type Detection =
  | { kind: 'match'; entry: InteractiveEntry; source: DetectionSource }
  | { kind: 'ambiguous'; candidates: string[]; source: DetectionSource }
  | { kind: 'none' };

export interface InteractiveMatcher {
  detect(pr: { branch?: string; title?: string; description?: string }): Detection;
  lookup(name: string): InteractiveEntry | undefined;
  /** Changes whenever an interactive is added/removed/renamed; used to trigger a re-scan. */
  fingerprint: string;
}

interface Pattern {
  entry: InteractiveEntry;
  key: string;
  regex: RegExp;
}

export function buildMatcher(entries: InteractiveEntry[]): InteractiveMatcher {
  const byKey = new Map<string, InteractiveEntry>();
  for (const e of entries) {
    const key = normalizeKey(e.name);
    if (key && !byKey.has(key)) byKey.set(key, e);
  }

  const patterns: Pattern[] = [];
  for (const [key, entry] of byKey) {
    if (!isCodeLike(entry.name)) continue;
    patterns.push({ entry, key, regex: namePattern(entry.name) });
  }

  const find = (text: string | undefined): Pattern[] => {
    if (!text) return [];
    const hits = patterns.filter((p) => p.regex.test(text));
    // "WNO_qcode_10682" is also found inside "WNO_qcode_10682_1": keep only the longest names.
    return hits.filter((h) => !hits.some((o) => o !== h && o.key.includes(h.key)));
  };

  return {
    detect(pr) {
      const sources: Array<[DetectionSource, string | undefined]> = [
        ['branch', pr.branch],
        ['title', pr.title],
        ['description', pr.description],
      ];
      // The most specific source that names anything decides; later sources are not consulted.
      for (const [source, text] of sources) {
        const hits = find(text);
        if (hits.length === 1) return { kind: 'match', entry: hits[0]!.entry, source };
        if (hits.length > 1) return { kind: 'ambiguous', candidates: hits.map((h) => h.entry.name).sort(), source };
      }
      return { kind: 'none' };
    },
    lookup(name) {
      return byKey.get(normalizeKey(name));
    },
    fingerprint: [...byKey.keys()].sort().join('|'),
  };
}

/** "SHA_qcode_30516_1.html" → "shaqcode305161" */
export function normalizeKey(name: string): string {
  return stripExt(name).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Only identifier-like names (containing "_" or a digit) are auto-detected. Plain-word names
 * such as "Translation" would match ordinary words in PR titles.
 */
export function isCodeLike(name: string): boolean {
  const base = stripExt(name).trim();
  return base.length >= 6 && /[_\d]/.test(base);
}

/**
 * Name chunks (split on separators and camelCase) joined by optional separators, bounded by
 * non-alphanumerics: "WNO_storyAnimations" matches "WNO_storyAnimations", "wno-story-animations",
 * but not "wno_storyanimationsx".
 */
function namePattern(name: string): RegExp {
  const chunks = stripExt(name)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return new RegExp(`(?<![a-z0-9])${chunks.join('[^a-z0-9]*')}(?![a-z0-9])`, 'i');
}

function stripExt(name: string): string {
  return name.trim().replace(/\.html?$/i, '');
}
