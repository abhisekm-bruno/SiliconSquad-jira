import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

import { loadConfig, loadCredentials, loadEnv, projectRoot } from './config.js';
import { JiraClient } from './jira.js';
import { buildStandup } from './standup.js';

loadEnv();

const publicDir = resolve(projectRoot, 'public');
const port = Number(process.env.PORT) || 5123;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const CACHE_TTL_MS = 30_000;
const cache = new Map();

const sendJson = (response, status, payload) => {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  response.end(body);
};

const serveStatic = async (request, response) => {
  const requestedPath = new URL(request.url, 'http://localhost').pathname;
  const relativePath = requestedPath === '/' ? 'index.html' : normalize(requestedPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(publicDir, relativePath);

  if (!filePath.startsWith(publicDir)) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const file = await readFile(filePath);
    response.writeHead(200, {
      'Content-Type': CONTENT_TYPES[extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    response.end(file);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
};

const handleStandup = async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const config = loadConfig();
  const lookbackHours = Number(url.searchParams.get('lookbackHours')) || config.defaultLookbackHours;
  const force = url.searchParams.get('refresh') === 'true';
  const cacheKey = `standup:${lookbackHours}`;

  const cached = cache.get(cacheKey);
  if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    sendJson(response, 200, { ...cached.payload, cached: true });
    return;
  }

  const jira = new JiraClient(loadCredentials());
  const payload = await buildStandup(jira, config, { lookbackHours });

  cache.set(cacheKey, { at: Date.now(), payload });
  sendJson(response, 200, { ...payload, cached: false });
};

const handleConfig = (response) => {
  const config = loadConfig();
  sendJson(response, 200, {
    team: config.team.name,
    projectKey: config.projectKey,
    boardId: config.boardId,
    workflow: config.workflow,
    thresholds: config.thresholds,
    defaultLookbackHours: config.defaultLookbackHours
  });
};

const server = createServer(async (request, response) => {
  const { pathname } = new URL(request.url, 'http://localhost');

  try {
    if (pathname === '/api/standup') return await handleStandup(request, response);
    if (pathname === '/api/config') return handleConfig(response);
    if (pathname.startsWith('/api/')) return sendJson(response, 404, { error: 'Unknown endpoint' });
    return await serveStatic(request, response);
  } catch (error) {
    const status = error.status === 401 || error.status === 403 ? error.status : 500;
    console.error(`[standup] ${error.message}`, error.payload ?? '');
    sendJson(response, status, {
      error: error.message,
      detail: error.payload ?? null,
      hint:
        status === 401
          ? 'Jira rejected the credentials. Check JIRA_EMAIL and JIRA_API_TOKEN in .env.'
          : undefined
    });
  }
});

server.listen(port, () => {
  console.log(`Jira standup dashboard running at http://localhost:${port}`);
});
