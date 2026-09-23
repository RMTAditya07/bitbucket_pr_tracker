export type LogLevel = 'info' | 'warn' | 'error';
export type LogFields = Record<string, string | number | boolean | null | undefined>;

export interface Logger {
  /** A named event, e.g. SYNC_STARTED, UNMAPPED_PR, RETRY. */
  event(level: LogLevel, event: string, fields?: LogFields): void;
  /** Per-PR outcome, rendered as the "PR 123 / Reviewer / Status / Action" block. */
  pr(prId: number, fields: LogFields, level?: LogLevel): void;
  /** Register values that must never appear in output (tokens, secrets). */
  addSecrets(values: string[]): void;
}

export function createLogger(
  format: 'text' | 'json' = 'text',
  write: (line: string) => void = (l) => process.stdout.write(l + '\n'),
): Logger {
  const secrets = new Set<string>();

  const redact = (s: string): string => {
    let out = s;
    for (const secret of secrets) {
      if (secret.length >= 4) out = out.split(secret).join('***');
    }
    return out;
  };

  const emit = (level: LogLevel, event: string, fields: LogFields, title: string) => {
    if (format === 'json') {
      write(redact(JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields })));
      return;
    }
    const prefix = level === 'info' ? '' : `[${level.toUpperCase()}] `;
    const lines = [`${prefix}${title}`];
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined || v === null || v === '') continue;
      if (event === 'PR' && k === 'prId') continue; // already in the "PR 123" title
      lines.push(`  ${humanize(k)}: ${v}`);
    }
    write(redact(lines.join('\n')));
  };

  return {
    event(level, event, fields = {}) {
      emit(level, event, fields, event.replace(/_/g, ' '));
    },
    pr(prId, fields, level = 'info') {
      emit(level, 'PR', { prId, ...fields }, `PR ${prId}`);
    },
    addSecrets(values) {
      for (const v of values) if (v) secrets.add(v);
    },
  };
}

function humanize(key: string): string {
  if (key === 'prId') return 'PR ID';
  const spaced = key.replace(/([a-z])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Logger that discards everything (useful in tests). */
export const silentLogger: Logger = { event() {}, pr() {}, addSecrets() {} };
