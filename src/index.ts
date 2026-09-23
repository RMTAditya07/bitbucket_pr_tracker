/**
 * One-shot sync.
 *   npm run sync            incremental (since last successful run)
 *   npm run sync -- --full  ignore the watermark and scan all PR history
 *   npm run sync -- --pr 123 --pr 456   only these PRs
 *   npm run sync -- --existing          every PR already in the sheet (e.g. to fill blank cells)
 * Exit code 0 = clean, 1 = some PRs failed or the run aborted, 2 = configuration error.
 */
import { createSyncDeps, runIncrementalSync, syncPullRequests } from './app.js';
import { ConfigError, loadConfig, loadDotEnv } from './config/env.js';
import { createLogger } from './logger/logger.js';
import { parsePrId } from './sync/identity.js';
import { COL } from './sync/mapper.js';

async function main(): Promise<number> {
  loadDotEnv();
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`Configuration error: ${err.message}`);
      return 2;
    }
    throw err;
  }

  const logger = createLogger(config.logFormat);
  const deps = createSyncDeps(config, logger);
  const args = process.argv.slice(2);

  const prIds = args.flatMap((a, i) => (a === '--pr' ? [Number(args[i + 1])] : []));
  if (prIds.some((id) => !Number.isInteger(id) || id <= 0)) {
    console.error('--pr expects a positive integer PR ID');
    return 2;
  }
  if (args.includes('--existing')) {
    const rows = await deps.sheet.readRows();
    prIds.push(...rows.flatMap((r) => parsePrId(r.values[COL.prId]) ?? []));
    logger.event('info', 'EXISTING_PRS', { count: new Set(prIds).size });
  }

  const summary = prIds.length
    ? await syncPullRequests(deps, prIds)
    : await runIncrementalSync(config, deps, { full: args.includes('--full') });

  return summary.aborted || summary.failed > 0 ? 1 : 0;
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
