import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Minimal .env reader. We stay dependency-free, so this handles the common cases
 * (KEY=value, optional `export ` prefix, optional surrounding quotes, # comments)
 * and nothing more exotic.
 */
export const loadEnv = () => {
  const envPath = resolve(projectRoot, '.env');
  if (!existsSync(envPath)) return;

  for (const rawLine of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue; // real environment wins

    let value = rawValue.trim();
    const quoted = /^"(.*)"$/s.exec(value) || /^'(.*)'$/s.exec(value);
    if (quoted) value = quoted[1];
    else value = value.split(' #')[0].trim();

    process.env[key] = value;
  }
};

const DEFAULTS = {
  team: { name: 'My Team', jiraTeam: null, members: [] },
  projectKey: '',
  boardId: null,
  sprintScope: 'active',
  workflow: {
    todo: ['To Do', 'Backlog', 'Open'],
    inProgress: ['In Progress'],
    inReview: ['In Review', 'Code Review'],
    qa: ['QA', 'In QA', 'Ready for QA', 'Testing'],
    done: ['Done', 'Closed']
  },
  thresholds: {
    staleInProgressDays: 3,
    staleInReviewDays: 2,
    staleInQaDays: 2,
    stalePrDays: 2
  },
  doneLookbackDays: 14,
  defaultLookbackHours: 24,
  devStatusApplicationTypes: ['GitHub'],
  qaFieldId: null,
  teamFieldId: null,
  teamFieldName: null,
  estimate: { hoursPerDay: 8, pointsToDays: 1 },
  extraJql: ''
};

export const loadConfig = () => {
  const configPath = resolve(projectRoot, 'config.json');
  if (!existsSync(configPath)) {
    throw new Error('config.json not found. Copy config.example.json to config.json and fill it in (npm run discover helps).');
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (err) {
    throw new Error(`config.json is not valid JSON: ${err.message}`);
  }

  const config = {
    ...DEFAULTS,
    ...parsed,
    team: { ...DEFAULTS.team, ...parsed.team },
    workflow: { ...DEFAULTS.workflow, ...parsed.workflow },
    thresholds: { ...DEFAULTS.thresholds, ...parsed.thresholds },
    estimate: { ...DEFAULTS.estimate, ...parsed.estimate }
  };

  if (!config.projectKey && !config.boardId) {
    throw new Error('config.json needs at least a projectKey or a boardId.');
  }

  return config;
};

export const loadCredentials = () => {
  const baseUrl = process.env.JIRA_BASE_URL;
  const email = process.env.JIRA_EMAIL;
  const apiToken = process.env.JIRA_API_TOKEN;

  const missing = [
    !baseUrl && 'JIRA_BASE_URL',
    !email && 'JIRA_EMAIL',
    !apiToken && 'JIRA_API_TOKEN'
  ].filter(Boolean);

  if (missing.length) {
    throw new Error(`Missing ${missing.join(', ')}. Copy .env.example to .env and fill it in.`);
  }

  return { baseUrl, email, apiToken };
};
