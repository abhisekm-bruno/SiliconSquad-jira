import { Buffer } from 'node:buffer';

/** Runs `worker` over `items` with at most `limit` in flight. */
export const mapWithConcurrency = async (items, limit, worker) => {
  const results = new Array(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
};

export class JiraClient {
  constructor({ baseUrl, email, apiToken }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.authHeader = `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`;
  }

  async request(path, { method = 'GET', body, query } = {}) {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }

    const response = await fetch(url, {
      method,
      headers: {
        Authorization: this.authHeader,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });

    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = text;
    }

    if (!response.ok) {
      const error = new Error(`Jira ${method} ${path} failed with ${response.status}`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }

    return payload;
  }

  /**
   * Jira Cloud replaced POST /rest/api/3/search with the token-paginated
   * /rest/api/3/search/jql. We prefer the new one and fall back for older sites.
   */
  async search(jql, { fields = ['*navigable'], pageSize = 100, maxIssues = 500 } = {}) {
    try {
      return await this.#searchByToken(jql, fields, pageSize, maxIssues);
    } catch (error) {
      if (error.status !== 404 && error.status !== 410) throw error;
      return await this.#searchByStartAt(jql, fields, pageSize, maxIssues);
    }
  }

  async #searchByToken(jql, fields, pageSize, maxIssues) {
    const issues = [];
    let nextPageToken;

    do {
      const page = await this.request('/rest/api/3/search/jql', {
        method: 'POST',
        body: { jql, fields, maxResults: pageSize, nextPageToken }
      });
      issues.push(...(page.issues || []));
      nextPageToken = page.nextPageToken;
    } while (nextPageToken && issues.length < maxIssues);

    return issues;
  }

  async #searchByStartAt(jql, fields, pageSize, maxIssues) {
    const issues = [];
    let startAt = 0;
    let total = Infinity;

    while (startAt < total && issues.length < maxIssues) {
      const page = await this.request('/rest/api/3/search', {
        method: 'POST',
        body: { jql, fields, maxResults: pageSize, startAt }
      });
      issues.push(...(page.issues || []));
      total = page.total ?? issues.length;
      startAt += pageSize;
      if (!page.issues?.length) break;
    }

    return issues;
  }

  async changelog(issueKey) {
    const histories = [];
    let startAt = 0;
    let isLast = false;

    while (!isLast) {
      const page = await this.request(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/changelog`, {
        query: { startAt, maxResults: 100 }
      });
      histories.push(...(page.values || []));
      isLast = page.isLast ?? true;
      startAt += page.maxResults || 100;
      if (!page.values?.length) break;
    }

    return histories;
  }

  /**
   * Jira's development panel — the same data the "Development" box on an issue
   * shows. It is an internal endpoint, so callers must tolerate it failing.
   */
  async pullRequests(issueId, applicationTypes = ['GitHub']) {
    const pullRequests = [];

    for (const applicationType of applicationTypes) {
      let detail;
      try {
        detail = await this.request('/rest/dev-status/1.0/issue/detail', {
          query: { issueId, applicationType, dataType: 'pullrequest' }
        });
      } catch {
        continue; // a site without that provider linked simply has nothing to give
      }

      for (const bucket of detail?.detail || []) {
        pullRequests.push(...(bucket.pullRequests || []));
      }
    }

    return pullRequests;
  }

  myself() {
    return this.request('/rest/api/3/myself');
  }

  fields() {
    return this.request('/rest/api/3/field');
  }

  projects() {
    return this.request('/rest/api/3/project/search', { query: { maxResults: 100 } });
  }

  boards(projectKeyOrId) {
    return this.request('/rest/agile/1.0/board', {
      query: { projectKeyOrId, maxResults: 100 }
    });
  }

  activeSprints(boardId) {
    return this.request(`/rest/agile/1.0/board/${boardId}/sprint`, {
      query: { state: 'active', maxResults: 50 }
    });
  }

  /** Every sprint on the board, newest first, so the lead can pick one. */
  async sprints(boardId, { keepClosed = 8 } = {}) {
    const all = [];
    let startAt = 0;
    let isLast = false;

    while (!isLast && all.length < 500) {
      const page = await this.request(`/rest/agile/1.0/board/${boardId}/sprint`, {
        query: { startAt, maxResults: 50 }
      });
      all.push(...(page.values || []));
      isLast = page.isLast ?? true;
      startAt += 50;
      if (!page.values?.length) break;
    }

    const byRecency = (a, b) =>
      new Date(b.startDate || b.createdDate || 0) - new Date(a.startDate || a.createdDate || 0);

    const open = all.filter((sprint) => sprint.state !== 'closed').sort(byRecency);
    const closed = all.filter((sprint) => sprint.state === 'closed').sort(byRecency).slice(0, keepClosed);

    return [...open, ...closed].map((sprint) => ({
      id: sprint.id,
      name: sprint.name,
      state: sprint.state,
      startDate: sprint.startDate || null,
      endDate: sprint.endDate || null
    }));
  }

  projectStatuses(projectKeyOrId) {
    return this.request(`/rest/api/3/project/${encodeURIComponent(projectKeyOrId)}/statuses`);
  }

  assignableUsers(projectKey) {
    return this.request('/rest/api/3/user/assignable/search', {
      query: { project: projectKey, maxResults: 200 }
    });
  }

  findUsersByEmail(email) {
    return this.request('/rest/api/3/user/search', { query: { query: email, maxResults: 10 } });
  }
}
