/**
 * Jira's development panel only knows about PRs when the GitHub integration
 * linked them via branch or commit. Teams that paste a PR link into the ticket
 * description get nothing from it, so we read those links too — and ask GitHub
 * directly for their state.
 */

const PULL_REQUEST_URL = /https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/gi;

/** Walks an Atlassian Document Format tree collecting every URL it carries. */
const collectUrls = (node, found = []) => {
  if (!node || typeof node !== 'object') return found;

  if (Array.isArray(node)) {
    for (const child of node) collectUrls(child, found);
    return found;
  }

  // Smart links render as cards; plain links are text with a link mark.
  if (node.attrs?.url) found.push(node.attrs.url);
  if (node.attrs?.href) found.push(node.attrs.href);
  for (const mark of node.marks || []) {
    if (mark.attrs?.href) found.push(mark.attrs.href);
  }
  if (typeof node.text === 'string') found.push(node.text);

  if (node.content) collectUrls(node.content, found);
  return found;
};

export const findPullRequestLinks = (description) => {
  if (!description) return [];

  const haystack = typeof description === 'string' ? [description] : collectUrls(description);
  const byUrl = new Map();

  for (const candidate of haystack) {
    if (typeof candidate !== 'string') continue;

    PULL_REQUEST_URL.lastIndex = 0;
    let match;
    while ((match = PULL_REQUEST_URL.exec(candidate)) !== null) {
      const [url, owner, repo, number] = match;
      const key = `${owner}/${repo}#${number}`.toLowerCase();
      if (!byUrl.has(key)) byUrl.set(key, { url, owner, repo, number: Number(number) });
    }
  }

  return [...byUrl.values()];
};

const cache = new Map();

/**
 * Asks GitHub for a PR's state. A token lifts the rate limit and reaches
 * private repos; without one, public repos still answer.
 */
export const fetchPullRequest = async ({ owner, repo, number, url }, token) => {
  const key = `${owner}/${repo}#${number}`;
  if (cache.has(key)) return cache.get(key);

  let summary = {
    id: key,
    name: `${repo}#${number}`,
    url,
    status: null, // unknown until GitHub answers
    source: 'description',
    reviewers: []
  };

  try {
    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${number}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'jira-standup-board',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      }
    });

    if (response.ok) {
      const pull = await response.json();
      summary = {
        ...summary,
        name: pull.title || summary.name,
        status: pull.merged_at ? 'MERGED' : pull.state === 'closed' ? 'DECLINED' : 'OPEN',
        draft: Boolean(pull.draft),
        lastUpdate: pull.updated_at || null,
        author: pull.user?.login || null,
        repository: `${owner}/${repo}`
      };
    }
  } catch {
    // Offline, rate-limited or private without a token: keep the link, drop the state.
  }

  cache.set(key, summary);
  return summary;
};
