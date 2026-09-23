import type { Logger } from '../logger/logger.js';

/** Non-retryable HTTP failure (or retryable one that exhausted its attempts). */
export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
  }
}

/** Credentials rejected. Fatal for the whole run: every further call would fail the same way. */
export class AuthError extends Error {}

export interface HttpResponse {
  status: number;
  headers: Headers;
  /** Parsed JSON when the body is JSON, otherwise the raw text. */
  body: unknown;
}

export interface RequestOptions {
  service: string;
  timeoutMs: number;
  maxAttempts: number;
  logger: Logger;
  sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const MAX_BACKOFF_MS = 30_000;
const MAX_RETRY_AFTER_MS = 120_000;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * fetch with timeout + retries for transient failures (network errors, timeouts, 408/429/5xx).
 * Returns the final response for any other status; callers decide what counts as an error.
 */
export async function request(url: string, init: RequestInit, opts: RequestOptions): Promise<HttpResponse> {
  const sleep = opts.sleep ?? defaultSleep;
  let lastError: unknown;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(opts.timeoutMs) });
    } catch (err) {
      lastError = err;
      if (attempt === opts.maxAttempts) break;
      const delay = backoff(attempt);
      opts.logger.event('warn', 'RETRY', {
        service: opts.service,
        reason: describeNetworkError(err),
        attempt,
        delayMs: delay,
      });
      await sleep(delay);
      continue;
    }

    const body = await readBody(res);
    if (RETRYABLE_STATUS.has(res.status) && attempt < opts.maxAttempts) {
      const delay = retryAfterMs(res.headers) ?? backoff(attempt);
      opts.logger.event('warn', 'RETRY', { service: opts.service, status: res.status, attempt, delayMs: delay });
      await sleep(delay);
      continue;
    }
    return { status: res.status, headers: res.headers, body };
  }

  throw new HttpError(
    `${opts.service}: request failed after ${opts.maxAttempts} attempts (${describeNetworkError(lastError)})`,
    0,
    '',
  );
}

function backoff(attempt: number): number {
  const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (attempt - 1));
  return Math.round(base / 2 + Math.random() * (base / 2));
}

function retryAfterMs(headers: Headers): number | null {
  const raw = headers.get('retry-after');
  if (!raw) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, secs * 1000));
  const date = Date.parse(raw);
  return Number.isNaN(date) ? null : Math.min(MAX_RETRY_AFTER_MS, Math.max(0, date - Date.now()));
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function describeNetworkError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'timeout';
    const cause = (err as { cause?: { code?: string } }).cause;
    return cause?.code ? `${err.message} (${cause.code})` : err.message;
  }
  return String(err);
}

/** Short, single-line excerpt of a response body for error messages. */
export function excerpt(body: unknown, max = 300): string {
  const s = typeof body === 'string' ? body : JSON.stringify(body);
  return (s ?? '').replace(/\s+/g, ' ').slice(0, max);
}
