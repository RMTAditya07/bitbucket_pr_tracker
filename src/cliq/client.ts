import type { Config } from '../config/env.js';
import { HttpError, excerpt, request } from '../http/request.js';
import type { Logger } from '../logger/logger.js';
import { normalizeName } from '../sync/identity.js';

export interface CliqUser {
  id: string;
  name: string;
  email: string;
}

/**
 * Zoho Cliq REST API v2: list users, and post a bot message to one user. Uses the same Zoho OAuth
 * token as the sheet (scopes ZohoCliq.Users.READ and ZohoCliq.Webhooks.CREATE).
 */
export class CliqClient {
  constructor(
    private readonly config: Config['cliq'],
    private readonly http: Config['http'],
    private readonly logger: Logger,
    private readonly accessToken: () => Promise<string>,
  ) {}

  async users(): Promise<CliqUser[]> {
    const out: CliqUser[] = [];
    let next: string | undefined;
    do {
      const query = new URLSearchParams({ limit: '100', ...(next ? { next_token: next } : {}) });
      const body = (await this.call('GET', `/api/v2/users?${query}`)) as {
        data?: Array<{ id?: unknown; zuid?: unknown; display_name?: string; name?: string; email_id?: string }>;
        next_token?: string;
      };
      for (const u of body.data ?? []) {
        out.push({ id: String(u.zuid ?? u.id ?? ''), name: u.display_name || u.name || '', email: u.email_id ?? '' });
      }
      next = body.next_token || undefined;
    } while (next);
    return out;
  }

  /** Posts `text` from the bot into its chat with one user (who must be subscribed to the bot). */
  async sendBotMessage(userId: string, text: string): Promise<void> {
    await this.call('POST', `/api/v2/bots/${encodeURIComponent(this.config.botName)}/message`, {
      text,
      userids: userId,
    });
  }

  private async call(method: 'GET' | 'POST', path: string, json?: unknown): Promise<unknown> {
    const res = await request(
      `${this.config.apiUrl}${path}`,
      {
        method,
        headers: {
          Authorization: `Zoho-oauthtoken ${await this.accessToken()}`,
          ...(json ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(json ? { body: JSON.stringify(json) } : {}),
      },
      { service: 'zoho-cliq', ...this.http, logger: this.logger },
    );
    if (res.status >= 200 && res.status < 300) return res.body;
    throw new HttpError(`cliq: ${method} ${path.split('?')[0]} failed (HTTP ${res.status}): ${excerpt(res.body)}`, res.status, excerpt(res.body));
  }
}

/**
 * The Cliq user for a sheet name (a Bitbucket display name): the email in CLIQ_USER_MAP if listed;
 * else an exact name; else the one user whose Cliq name starts with it ("Shravya Das" ->
 * "Shravya Das V D"). Ambiguous = no match.
 */
export function findCliqUser(name: string, users: CliqUser[], userMap = new Map<string, string>()): CliqUser | undefined {
  const n = normalizeName(name);
  if (!n) return undefined;
  const email = userMap.get(n);
  if (email) return users.find((u) => u.email.toLowerCase() === email);
  const exact = users.filter((u) => normalizeName(u.name) === n);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return undefined;
  const prefix = users.filter((u) => normalizeName(u.name).startsWith(`${n} `));
  return prefix.length === 1 ? prefix[0] : undefined;
}
