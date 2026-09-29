/**
 * PR digest to Zoho Cliq: each author gets their open PRs by build drop and what each needs next;
 * each reviewer gets the fresh reviews and re-reviews waiting on them. Reads PR Reviews + Review Rota.
 *   npm run digest                          dry run: print the messages, send nothing
 *   npm run digest -- --send                send them through the Cliq bot (CLIQ_BOT_NAME)
 *   npm run digest -- --evening             end-of-day wording, plus PRs merged today
 *   npm run digest -- --to "Name" [--to …]  only these people (sheet names)
 * Exit code 0 = clean, 1 = failed (or a message could not be sent), 2 = configuration error.
 * People with no matching Cliq user are logged (CLIQ_USER_NOT_FOUND) and skipped.
 */
import { CliqClient, findCliqUser } from './cliq/client.js';
import { ConfigError, loadConfig, loadDotEnv, secretValues } from './config/env.js';
import { planDigests, type DigestKind } from './digest/plan.js';
import { createLogger } from './logger/logger.js';
import { normalizeName } from './sync/identity.js';
import { formatDateTime } from './sync/mapper.js';
import { ZohoClient } from './zoho/client.js';
import { ZohoSheetStore } from './zoho/sheet.js';

interface Args {
  send: boolean;
  kind: DigestKind;
  to: string[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = { send: false, kind: 'morning', to: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--send') args.send = true;
    else if (a === '--evening') args.kind = 'evening';
    else if (a === '--morning') args.kind = 'morning';
    else if (a === '--to' && argv[i + 1]) args.to.push(argv[++i]!);
    else throw new ConfigError(`Unknown argument "${a}". Use --send, --evening, --to "Name"`);
  }
  return args;
}

async function main(): Promise<number> {
  loadDotEnv();
  let config;
  let args: Args;
  try {
    config = loadConfig();
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`Configuration error: ${err.message}`);
      return 2;
    }
    throw err;
  }

  const logger = createLogger(config.logFormat);
  logger.addSecrets(secretValues(config));
  const zoho = new ZohoClient(config.zoho, config.http, logger);
  const sheet = new ZohoSheetStore(zoho, config.zoho, logger);
  const cliq = new CliqClient(config.cliq, config.http, logger, () => zoho.accessToken());

  const rows = await sheet.readRows();
  const rota = await sheet.readReviewRota();
  const today = formatDateTime(new Date(), config.sync.timezone).slice(0, 10);
  const { workspace, repository } = config.bitbucket;
  let digests = planDigests({
    rows: rows.map((r) => r.values),
    rota,
    today,
    kind: args.kind,
    prUrl: (id) => `https://bitbucket.org/${workspace}/${repository}/pull-requests/${id}`,
    sheetUrl: `${config.zoho.sheetApiUrl}/sheet/open/${config.zoho.resourceId}`,
  });
  if (args.to.length) {
    const only = new Set(args.to.map(normalizeName));
    digests = digests.filter((d) => only.has(normalizeName(d.person)));
  }
  logger.event('info', 'DIGEST_PLANNED', { kind: args.kind, today, people: digests.length, send: args.send });

  const users = await cliq.users();
  let sent = 0;
  let unmatched = 0;
  let failed = 0;
  for (const d of digests) {
    const user = findCliqUser(d.person, users, config.cliq.userMap);
    if (!user) {
      unmatched++;
      logger.event('warn', 'CLIQ_USER_NOT_FOUND', {
        person: d.person,
        note: 'No single Cliq user has this name. Add it to CLIQ_USER_MAP as "Name=email".',
      });
    }
    if (!args.send) {
      const to = user ? `${user.name} <${user.email}>` : 'NO CLIQ USER';
      process.stdout.write(`\n===== ${d.person} → ${to} (${d.text.length} chars) =====\n${d.text}\n`);
      continue;
    }
    if (!user) continue;
    try {
      await cliq.sendBotMessage(user.id, d.text);
      sent++;
      logger.event('info', 'DIGEST_SENT', { person: d.person, authored: d.authored, reviews: d.reviews });
    } catch (err) {
      failed++;
      logger.event('error', 'DIGEST_SEND_FAILED', {
        person: d.person,
        error: err instanceof Error ? err.message : String(err),
        note: 'If the user is not subscribed to the bot, ask them to open it in Cliq and subscribe.',
      });
    }
  }
  logger.event('info', 'DIGEST_SUMMARY', { people: digests.length, sent, unmatched, failed, dryRun: !args.send });
  return failed ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error('Unexpected error:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  },
);
