import { existsSync } from 'node:fs';

export type BitbucketAuth =
  | { kind: 'bearer'; token: string }
  | { kind: 'basic'; username: string; password: string }
  | { kind: 'oauth_client_credentials'; clientId: string; clientSecret: string };

export interface Config {
  bitbucket: {
    apiUrl: string;
    oauthTokenUrl: string;
    workspace: string;
    repository: string;
    auth: BitbucketAuth;
  };
  zoho: {
    accountsUrl: string;
    sheetApiUrl: string;
    clientId: string;
    clientSecret: string;
    refreshToken: string;
    resourceId: string;
    worksheetName: string;
    mappingWorksheetName: string | null;
    reviewerLevelsWorksheetName: string | null;
    /** Review Rota worksheet (Developer, L1/L2 Reviewer, From, To). Null = engaged mode for every PR. */
    reviewRotaWorksheetName: string | null;
    /** Worksheets listing interactives (Interactive Name, Interactive Type) for auto-detection. */
    interactiveWorksheetNames: string[];
    minRequestIntervalMs: number;
  };
  /** Jira Cloud, for the build tracker status refresh. Null when not configured. */
  jira: {
    baseUrl: string;
    email: string;
    apiToken: string;
    /** Custom field holding story points (customfield_10028 on ei-study). */
    storyPointsField: string;
  } | null;
  /** Zoho Cliq, for the PR digest. Uses the Zoho OAuth client above. */
  cliq: {
    apiUrl: string;
    /** Unique name of the bot that sends the digest. */
    botName: string;
    /** Sheet name -> Cliq email, for people whose Cliq name differs from their Bitbucket name. */
    userMap: Map<string, string>;
  };
  tracker: {
    /** Tab with Ticket + Build Drop date: the date that decides which interactives are refreshed. */
    buildSourceWorksheetName: string;
    /** One row per due interactive: Jira phase progress and completion forecast. */
    completionWorksheetName: string;
  };
  sync: {
    intervalMinutes: number;
    initialLookbackDays: number;
    stateFile: string;
    timezone: string;
    insertUnmapped: boolean;
  };
  http: {
    timeoutMs: number;
    maxAttempts: number;
  };
  logFormat: 'text' | 'json';
}

export class ConfigError extends Error {}

/** Loads `.env` (if present) into process.env without overriding real env vars. */
export function loadDotEnv(path = '.env'): void {
  if (existsSync(path)) process.loadEnvFile(path);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing: string[] = [];
  const req = (name: string): string => {
    const v = env[name]?.trim();
    if (!v) missing.push(name);
    return v ?? '';
  };
  const opt = (name: string): string | null => env[name]?.trim() || null;
  const num = (name: string, fallback: number): number => {
    const raw = opt(name);
    if (raw === null) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) throw new ConfigError(`${name} must be a non-negative number, got "${raw}"`);
    return n;
  };

  const workspace = req('BITBUCKET_WORKSPACE');
  const repository = req('BITBUCKET_REPOSITORY');
  const auth = resolveBitbucketAuth(env);
  if (!auth) {
    missing.push(
      'BITBUCKET_ACCESS_TOKEN | (BITBUCKET_EMAIL + BITBUCKET_API_TOKEN) | (BITBUCKET_CLIENT_ID + BITBUCKET_CLIENT_SECRET)',
    );
  }

  const zoho = {
    accountsUrl: stripSlash(opt('ZOHO_ACCOUNTS_URL') ?? 'https://accounts.zoho.com'),
    sheetApiUrl: stripSlash(opt('ZOHO_SHEET_API_URL') ?? 'https://sheet.zoho.com'),
    clientId: req('ZOHO_CLIENT_ID'),
    clientSecret: req('ZOHO_CLIENT_SECRET'),
    refreshToken: req('ZOHO_REFRESH_TOKEN'),
    resourceId: req('ZOHO_SHEET_ID'),
    worksheetName: req('ZOHO_WORKSHEET_NAME'),
    mappingWorksheetName: opt('ZOHO_MAPPING_WORKSHEET_NAME'),
    reviewerLevelsWorksheetName: opt('ZOHO_REVIEWER_LEVELS_WORKSHEET_NAME'),
    reviewRotaWorksheetName: opt('ZOHO_REVIEW_ROTA_WORKSHEET_NAME'),
    interactiveWorksheetNames: (opt('ZOHO_INTERACTIVE_WORKSHEETS') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    minRequestIntervalMs: num('ZOHO_MIN_REQUEST_INTERVAL_MS', 1000),
  };

  if (missing.length) {
    throw new ConfigError(`Missing required configuration: ${missing.join(', ')}`);
  }

  const timezone = opt('SHEET_TIMEZONE') ?? 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    throw new ConfigError(`SHEET_TIMEZONE "${timezone}" is not a valid IANA time zone`);
  }

  const jiraBaseUrl = opt('JIRA_BASE_URL');
  const jiraEmail = opt('JIRA_EMAIL');
  const jiraApiToken = opt('JIRA_API_TOKEN');
  const jiraSet = [jiraBaseUrl, jiraEmail, jiraApiToken].filter(Boolean).length;
  if (jiraSet > 0 && jiraSet < 3) {
    throw new ConfigError('Set all of JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN, or none of them');
  }

  const logFormat = opt('LOG_FORMAT') ?? 'text';
  if (logFormat !== 'text' && logFormat !== 'json') throw new ConfigError('LOG_FORMAT must be "text" or "json"');

  return {
    bitbucket: {
      apiUrl: stripSlash(opt('BITBUCKET_API_URL') ?? 'https://api.bitbucket.org/2.0'),
      oauthTokenUrl: opt('BITBUCKET_OAUTH_TOKEN_URL') ?? 'https://bitbucket.org/site/oauth2/access_token',
      workspace,
      repository,
      auth: auth!,
    },
    zoho,
    jira: jiraSet
      ? {
          baseUrl: stripSlash(jiraBaseUrl!),
          email: jiraEmail!,
          apiToken: jiraApiToken!,
          storyPointsField: opt('JIRA_STORY_POINTS_FIELD') ?? 'customfield_10028',
        }
      : null,
    cliq: {
      // Same data centre as the accounts server: accounts.zoho.in -> cliq.zoho.in
      apiUrl: stripSlash(opt('CLIQ_API_URL') ?? zoho.accountsUrl.replace('://accounts.', '://cliq.')),
      botName: opt('CLIQ_BOT_NAME') ?? 'prreviewdigest',
      userMap: parseUserMap(opt('CLIQ_USER_MAP') ?? ''),
    },
    tracker: {
      buildSourceWorksheetName: opt('TRACKER_BUILD_SOURCE_WORKSHEET') ?? 'Static Interactives',
      completionWorksheetName: opt('TRACKER_COMPLETION_WORKSHEET') ?? 'INTERACTIVE_COMPLETION',
    },
    sync: {
      intervalMinutes: num('SYNC_INTERVAL_MINUTES', 15),
      initialLookbackDays: num('SYNC_INITIAL_LOOKBACK_DAYS', 90),
      stateFile: opt('SYNC_STATE_FILE') ?? '.sync-state.json',
      timezone,
      insertUnmapped: (opt('SYNC_INSERT_UNMAPPED_PRS') ?? 'true').toLowerCase() !== 'false',
    },
    http: {
      timeoutMs: num('HTTP_TIMEOUT_MS', 30_000),
      maxAttempts: Math.max(1, num('HTTP_MAX_ATTEMPTS', 4)),
    },
    logFormat,
  };
}

/** Precedence: access token → API token (email + token) → OAuth consumer. */
function resolveBitbucketAuth(env: NodeJS.ProcessEnv): BitbucketAuth | null {
  const v = (k: string) => env[k]?.trim() || '';
  if (v('BITBUCKET_ACCESS_TOKEN')) return { kind: 'bearer', token: v('BITBUCKET_ACCESS_TOKEN') };
  if (v('BITBUCKET_EMAIL') && v('BITBUCKET_API_TOKEN')) {
    return { kind: 'basic', username: v('BITBUCKET_EMAIL'), password: v('BITBUCKET_API_TOKEN') };
  }
  if (v('BITBUCKET_CLIENT_ID') && v('BITBUCKET_CLIENT_SECRET')) {
    return {
      kind: 'oauth_client_credentials',
      clientId: v('BITBUCKET_CLIENT_ID'),
      clientSecret: v('BITBUCKET_CLIENT_SECRET'),
    };
  }
  return null;
}

/** Every secret value in the config, so the logger can redact them. */
export function secretValues(config: Config): string[] {
  const a = config.bitbucket.auth;
  const bb =
    a.kind === 'bearer' ? [a.token] : a.kind === 'basic' ? [a.password] : [a.clientId, a.clientSecret];
  return [...bb, config.zoho.clientId, config.zoho.clientSecret, config.zoho.refreshToken, config.jira?.apiToken ?? '']
    .filter(Boolean);
}

/** "Stephen Prabhu=stephen@x.com; Other Name=other@x.com" -> name -> email */
function parseUserMap(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const pair of raw.split(';')) {
    if (!pair.trim()) continue;
    const [name, email] = pair.split('=').map((x) => x.trim());
    if (!name || !email || !email.includes('@')) {
      throw new ConfigError(`CLIQ_USER_MAP entry "${pair.trim()}" must look like "Sheet Name=email@example.com"`);
    }
    out.set(name.replace(/\s+/g, ' ').toLowerCase(), email.toLowerCase());
  }
  return out;
}

function stripSlash(s: string): string {
  return s.replace(/\/+$/, '');
}
