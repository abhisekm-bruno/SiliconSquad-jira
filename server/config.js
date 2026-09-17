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
  qaEngineers: [],
  teamFieldId: null,
  teamFieldName: null,
  estimate: { hoursPerDay: 8, pointsToDays: 1 },
  extraJql: ''
};

/**
 * Blanks out // and /* *\/ comments and trailing commas, replacing each with
 * spaces so every remaining character keeps its original offset — that way a
 * parse error still points at the right line in the file the user edited.
 */
const relaxJson = (text) => {
  const out = [...text];
  let inString = false;
  let escaped = false;
  let comment = null; // 'line' | 'block'

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (comment === 'line') {
      if (char === '\n') comment = null;
      else out[i] = ' ';
      continue;
    }

    if (comment === 'block') {
      const ending = char === '*' && next === '/';
      out[i] = char === '\n' ? '\n' : ' ';
      if (ending) {
        out[i + 1] = ' ';
        i++;
        comment = null;
      }
      continue;
    }

    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '/' && next === '/') {
      out[i] = ' ';
      comment = 'line';
      continue;
    }

    if (char === '/' && next === '*') {
      out[i] = ' ';
      comment = 'block';
      continue;
    }
  }

  // Trailing commas: a comma whose next non-space character closes the block.
  const relaxed = out.join('');
  return relaxed.replace(/,(\s*[}\]])/g, ' $1');
};

/** Turns a character offset into a "line 7, column 3" plus the offending line. */
const describeSyntaxError = (text, message) => {
  const position = Number(/position (\d+)/.exec(message)?.[1]);
  if (!Number.isFinite(position)) return message;

  const before = text.slice(0, position);
  const line = before.split('\n').length;
  const column = position - before.lastIndexOf('\n');
  const source = text.split('\n')[line - 1] || '';

  return [
    `${message.replace(/ in JSON at position \d+.*$/, '')} (line ${line}, column ${column})`,
    '',
    `  ${line} | ${source}`,
    `  ${' '.repeat(String(line).length)} | ${' '.repeat(Math.max(0, column - 1))}^`
  ].join('\n');
};

export const loadConfig = () => {
  const configPath = resolve(projectRoot, 'config.json');
  if (!existsSync(configPath)) {
    throw new Error('config.json not found. Copy config.example.json to config.json and fill it in (npm run discover helps).');
  }

  const text = readFileSync(configPath, 'utf8');

  let parsed;
  try {
    // Comments and trailing commas are tolerated: people copy config out of
    // documentation, and a stray // should not take the board down.
    parsed = JSON.parse(relaxJson(text));
  } catch (err) {
    throw new Error(`config.json could not be read: ${describeSyntaxError(text, err.message)}`);
  }

  const config = {
    ...DEFAULTS,
    ...parsed,
    // The QA roster reads naturally under "team" too, so accept it either way.
    qaEngineers: parsed.qaEngineers || parsed.team?.qaEngineers || DEFAULTS.qaEngineers,
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
