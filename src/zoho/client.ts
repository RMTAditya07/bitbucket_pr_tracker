import type { Config } from '../config/env.js';
import { AuthError, HttpError, excerpt, request } from '../http/request.js';
import type { Logger } from '../logger/logger.js';
import { FatalSyncError } from '../sync/synchronizer.js';

/** Zoho Sheet error codes we act on (see Zoho Sheet Data API "Error codes"). */
const ZOHO_AUTH_FAILURE = 2401;
const ZOHO_THROTTLED = 2950;

export class ZohoApiError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
  ) {
    super(message);
  }
}

/**
 * Minimal Zoho Sheet v2 client: OAuth refresh-token flow + `POST /api/v2/{resource_id}` with
 * form-encoded `method=...` params. Calls are serialized and spaced by `minRequestIntervalMs`
 * because Zoho locks a document for 5 minutes when its per-minute limit is exceeded.
 */
export class ZohoClient {
  private token: { value: string; expiresAt: number } | null = null;
  private lastCallAt = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly config: Config['zoho'],
    private readonly http: Config['http'],
    private readonly logger: Logger,
  ) {}

  /** Serialized so concurrent callers still respect the request spacing. */
  call<T = Record<string, unknown>>(params: Record<string, string>): Promise<T> {
    const run = this.queue.then(() => this.doCall<T>(params));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async doCall<T>(params: Record<string, string>): Promise<T> {
    for (let authAttempt = 1; authAttempt <= 2; authAttempt++) {
      await this.throttle();
      const res = await request(
        `${this.config.sheetApiUrl}/api/v2/${encodeURIComponent(this.config.resourceId)}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Zoho-oauthtoken ${await this.accessToken()}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams(params),
        },
        { service: 'zoho-sheet', ...this.http, logger: this.logger },
      );

      const body = (res.body ?? {}) as { status?: string; error_code?: number; error_message?: string };
      const code = typeof body.error_code === 'number' ? body.error_code : Number(body.error_code) || null;

      if (res.status >= 200 && res.status < 300 && body.status !== 'failure') return body as T;

      if ((res.status === 401 || code === ZOHO_AUTH_FAILURE) && authAttempt === 1) {
        this.token = null; // access token rejected; refresh once and retry
        continue;
      }
      if (res.status === 401 || code === ZOHO_AUTH_FAILURE) {
        throw new AuthError(`zoho: authentication failed (${body.error_message ?? `HTTP ${res.status}`})`);
      }
      if (code === ZOHO_THROTTLED) {
        throw new FatalSyncError(
          'zoho: throttle limit exceeded (2950). Zoho blocks this document for ~5 minutes; ' +
            'increase ZOHO_MIN_REQUEST_INTERVAL_MS.',
        );
      }
      const message = `zoho: ${params.method} failed (HTTP ${res.status}, code ${code ?? 'n/a'}): ${
        body.error_message ?? excerpt(res.body)
      }`;
      throw code !== null ? new ZohoApiError(message, code) : new HttpError(message, res.status, excerpt(res.body));
    }
    throw new AuthError('zoho: authentication failed after token refresh');
  }

  private async throttle(): Promise<void> {
    const wait = this.lastCallAt + this.config.minRequestIntervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastCallAt = Date.now();
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;

    const res = await request(
      `${this.config.accountsUrl}/oauth/v2/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: this.config.refreshToken,
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
        }),
      },
      { service: 'zoho-oauth', ...this.http, logger: this.logger },
    );
    // Zoho reports OAuth errors with HTTP 200 and an `error` field.
    const body = res.body as { access_token?: string; expires_in?: number; error?: string } | null;
    if (!body?.access_token) {
      throw new AuthError(
        `zoho: refresh-token exchange failed (HTTP ${res.status}${body?.error ? `, ${body.error}` : ''}). ` +
          'Check ZOHO_CLIENT_ID/SECRET/REFRESH_TOKEN and that ZOHO_ACCOUNTS_URL matches your data centre.',
      );
    }
    this.token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
    return body.access_token;
  }
}
