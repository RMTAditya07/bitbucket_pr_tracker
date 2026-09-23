import type { Config } from '../config/env.js';
import { AuthError, HttpError, excerpt, request } from '../http/request.js';
import type { Logger } from '../logger/logger.js';
import type { BbPage } from './types.js';

export class BitbucketClient {
  private oauthToken: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly config: Config['bitbucket'],
    private readonly http: Config['http'],
    private readonly logger: Logger,
  ) {}

  /** GET a path (relative to the API root) or an absolute `next` URL. Returns null on 404. */
  async get<T>(pathOrUrl: string): Promise<T | null> {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${this.config.apiUrl}${pathOrUrl}`;

    for (let authAttempt = 1; authAttempt <= 2; authAttempt++) {
      const res = await request(
        url,
        { headers: { Authorization: await this.authHeader(), Accept: 'application/json' } },
        { service: 'bitbucket', ...this.http, logger: this.logger },
      );
      if (res.status >= 200 && res.status < 300) return res.body as T;
      if (res.status === 404) return null;
      if (res.status === 401 && this.config.auth.kind === 'oauth_client_credentials' && authAttempt === 1) {
        this.oauthToken = null; // token may have expired early; fetch a new one once
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        throw new AuthError(
          `bitbucket: HTTP ${res.status} for ${redactUrl(url)} — check credentials and that they grant ` +
            `read access to pull requests in ${this.config.workspace}/${this.config.repository}`,
        );
      }
      throw new HttpError(`bitbucket: HTTP ${res.status} for ${redactUrl(url)}: ${excerpt(res.body)}`, res.status, excerpt(res.body));
    }
    throw new AuthError('bitbucket: authentication failed after token refresh');
  }

  /** Iterate every item across paginated `next` links. Stop early by breaking out of the loop. */
  async *paginate<T>(path: string): AsyncGenerator<T> {
    let next: string | undefined = path;
    while (next) {
      const page: BbPage<T> | null = await this.get<BbPage<T>>(next);
      if (!page) throw new HttpError(`bitbucket: 404 for ${redactUrl(next)} — check workspace/repository`, 404, '');
      yield* page.values;
      next = page.next;
    }
  }

  repoPath(): string {
    return `/repositories/${encodeURIComponent(this.config.workspace)}/${encodeURIComponent(this.config.repository)}`;
  }

  private async authHeader(): Promise<string> {
    const auth = this.config.auth;
    switch (auth.kind) {
      case 'bearer':
        return `Bearer ${auth.token}`;
      case 'basic':
        return `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`;
      case 'oauth_client_credentials':
        return `Bearer ${await this.clientCredentialsToken(auth.clientId, auth.clientSecret)}`;
    }
  }

  private async clientCredentialsToken(clientId: string, clientSecret: string): Promise<string> {
    if (this.oauthToken && this.oauthToken.expiresAt > Date.now() + 60_000) return this.oauthToken.value;

    const res = await request(
      this.config.oauthTokenUrl,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ grant_type: 'client_credentials' }),
      },
      { service: 'bitbucket-oauth', ...this.http, logger: this.logger },
    );
    const body = res.body as { access_token?: string; expires_in?: number; error_description?: string } | null;
    if (res.status !== 200 || !body?.access_token) {
      throw new AuthError(
        `bitbucket: OAuth client-credentials token request failed (HTTP ${res.status}` +
          `${body?.error_description ? `: ${body.error_description}` : ''})`,
      );
    }
    this.oauthToken = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
    return body.access_token;
  }
}

function redactUrl(url: string): string {
  return url.replace(/([?&](access_token|token)=)[^&]+/gi, '$1***');
}
