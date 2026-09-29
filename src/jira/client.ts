import type { Config } from '../config/env.js';
import { AuthError, HttpError, excerpt, request } from '../http/request.js';
import type { Logger } from '../logger/logger.js';

const SEARCH_BATCH = 100; // keys per JQL query; keeps the query string well under Jira's limits

export interface JiraTask {
  status: string;
  storyPoints: number | null;
  /** ISO date-time the task was resolved, or null. */
  resolvedAt: string | null;
}

interface IssueLink {
  type?: { name?: string };
  outwardIssue?: { key?: string };
}

interface SearchPage {
  issues?: Array<{ key: string; fields?: Record<string, unknown> }>;
  nextPageToken?: string;
  isLast?: boolean;
}

/** Minimal Jira Cloud client: basic auth (email + API token) and the enhanced JQL search. */
export class JiraClient {
  constructor(
    private readonly config: NonNullable<Config['jira']>,
    private readonly http: Config['http'],
    private readonly logger: Logger,
  ) {}

  /**
   * Phase tasks of each story: the issues it "is parent of" through the Parent-Child link
   * (Jira cannot nest Tasks under Stories, so the phases are linked, not children).
   */
  async linkedTasks(storyKeys: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    await this.eachIssue(storyKeys, ['issuelinks'], (key, fields) => {
      const links = (fields['issuelinks'] ?? []) as IssueLink[];
      out.set(
        key,
        links.filter((l) => l.type?.name === 'Parent-Child' && l.outwardIssue?.key).map((l) => l.outwardIssue!.key!),
      );
    });
    return out;
  }

  /** Status, story points and resolution time per issue key. Keys Jira does not return are absent from the map. */
  async tasks(keys: string[]): Promise<Map<string, JiraTask>> {
    const spField = this.config.storyPointsField;
    const out = new Map<string, JiraTask>();
    await this.eachIssue(keys, ['status', 'resolutiondate', spField], (key, fields) => {
      const status = (fields['status'] as { name?: string } | undefined)?.name;
      const sp = fields[spField];
      const resolved = fields['resolutiondate'];
      if (status) {
        out.set(key, {
          status,
          storyPoints: typeof sp === 'number' ? sp : null,
          resolvedAt: typeof resolved === 'string' ? resolved : null,
        });
      }
    });
    return out;
  }

  private async eachIssue(
    keys: string[],
    fields: string[],
    visit: (key: string, fields: Record<string, unknown>) => void,
  ): Promise<void> {
    for (let i = 0; i < keys.length; i += SEARCH_BATCH) {
      const jql = `key in (${keys.slice(i, i + SEARCH_BATCH).join(',')})`;
      let nextPageToken: string | undefined;
      do {
        const page = await this.search({ jql, fields, maxResults: SEARCH_BATCH, nextPageToken });
        for (const issue of page.issues ?? []) visit(issue.key, issue.fields ?? {});
        nextPageToken = page.isLast === false ? page.nextPageToken : undefined;
      } while (nextPageToken);
    }
  }

  private async search(body: Record<string, unknown>): Promise<SearchPage> {
    const url = `${this.config.baseUrl}/rest/api/3/search/jql`;
    const res = await request(
      url,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.config.email}:${this.config.apiToken}`).toString('base64')}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
      { service: 'jira', ...this.http, logger: this.logger },
    );
    if (res.status >= 200 && res.status < 300) return res.body as SearchPage;
    if (res.status === 401 || res.status === 403) {
      throw new AuthError(`jira: HTTP ${res.status} — check JIRA_EMAIL / JIRA_API_TOKEN and access to ${this.config.baseUrl}`);
    }
    throw new HttpError(`jira: HTTP ${res.status} for search: ${excerpt(res.body)}`, res.status, excerpt(res.body));
  }
}
