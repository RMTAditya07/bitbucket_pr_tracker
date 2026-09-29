/**
 * Build tracker refresh, for every interactive whose Build Drop date (Static Interactives) is today
 * or later: rolls its Jira phase-task statuses up into Static Interactives' Status, and keeps its
 * INTERACTIVE_COMPLETION row (phases done, SP done/remaining, completion date) current.
 *   npm run sync:tracker
 * Exit code 0 = clean, 1 = failed, 2 = configuration error.
 */
import { ConfigError, loadConfig, loadDotEnv, secretValues } from './config/env.js';
import { JiraClient } from './jira/client.js';
import { createLogger } from './logger/logger.js';
import { runTrackerSync } from './tracker/sync.js';
import { ZohoClient } from './zoho/client.js';

async function main(): Promise<number> {
  loadDotEnv();
  let config;
  try {
    config = loadConfig();
    if (!config.jira) throw new ConfigError('Missing required configuration: JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN');
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`Configuration error: ${err.message}`);
      return 2;
    }
    throw err;
  }

  const logger = createLogger(config.logFormat);
  logger.addSecrets(secretValues(config));
  const summary = await runTrackerSync(
    new ZohoClient(config.zoho, config.http, logger),
    new JiraClient(config.jira, config.http, logger),
    { tracker: config.tracker, timeZone: config.sync.timezone },
    logger,
  );
  logger.event('info', 'TRACKER_SUMMARY', { ...summary });
  return 0;
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
