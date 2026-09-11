const LANES = {
  todo: { label: 'To do', color: 'var(--todo)' },
  inProgress: { label: 'In progress', color: 'var(--in-progress)' },
  inReview: { label: 'In review', color: 'var(--in-review)' },
  qa: { label: 'QA', color: 'var(--qa)' },
  done: { label: 'Done', color: 'var(--done)' }
};

const LANE_ORDER = Object.keys(LANES);

const VIEWS = ['developers', 'board', 'activity', 'attention'];

const state = {
  view: VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'developers',
  lookbackHours: 24,
  data: null,
  error: null,
  loading: false
};

const elements = {
  teamName: document.getElementById('team-name'),
  boardMeta: document.getElementById('board-meta'),
  lookback: document.getElementById('lookback'),
  refresh: document.getElementById('refresh'),
  tabs: document.getElementById('tabs'),
  attentionCount: document.getElementById('attention-count'),
  totals: document.getElementById('totals'),
  view: document.getElementById('view')
};

/* ---------- helpers ---------- */

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const laneColor = (bucket) => LANES[bucket]?.color || 'var(--border)';

const relativeTime = (isoString) => {
  if (!isoString) return '';
  const deltaMinutes = (Date.now() - new Date(isoString).getTime()) / 60000;

  if (deltaMinutes < 1) return 'just now';
  if (deltaMinutes < 60) return `${Math.round(deltaMinutes)}m ago`;
  if (deltaMinutes < 60 * 24) return `${Math.round(deltaMinutes / 60)}h ago`;
  return `${Math.round(deltaMinutes / (60 * 24))}d ago`;
};

const humanAge = (days) => {
  if (days === null || days === undefined) return '';
  if (days < 1) return `${Math.max(1, Math.round(days * 24))}h`;
  return `${Math.floor(days)}d`;
};

/* ---------- rendering pieces ---------- */

const renderPullRequest = (pullRequest) => {
  const status = String(pullRequest.status || '').toLowerCase();
  const label = status === 'merged' ? 'PR merged' : status === 'declined' ? 'PR declined' : 'PR open';
  const approvals = pullRequest.reviewers?.filter((reviewer) => reviewer.approved).length || 0;
  const suffix = status === 'open' && pullRequest.reviewers?.length
    ? ` ${approvals}/${pullRequest.reviewers.length}✓`
    : '';

  return `<a class="pr pr--${escapeHtml(status)}" href="${escapeHtml(pullRequest.url)}" target="_blank" rel="noreferrer"
    title="${escapeHtml(pullRequest.name || '')}">${label}${suffix}</a>`;
};

const renderFlags = (flags) =>
  flags
    .map((flag) => `<span class="flag flag--${escapeHtml(flag.severity)}">${escapeHtml(flag.label)}</span>`)
    .join('');

/** The line that answers "when did this reach QA / when did QA sign it off". */
const renderHandover = (issue) => {
  const { timeline } = issue;
  const parts = [];

  if (issue.bucket === 'qa' && timeline.movedToQa) {
    parts.push(
      `In QA since <strong>${relativeTime(timeline.movedToQa.at)}</strong> (moved by ${escapeHtml(timeline.movedToQa.by)})`
    );
  }

  if (timeline.qaHandover) {
    const cycle = timeline.qaCycleHours !== null ? ` · QA cycle ${timeline.qaCycleHours}h` : '';
    parts.push(
      `QA signed off by <strong>${escapeHtml(timeline.qaHandover.by)}</strong> ${relativeTime(timeline.qaHandover.at)}${cycle}`
    );
  } else if (issue.bucket === 'done' && timeline.movedToDone) {
    parts.push(`Done ${relativeTime(timeline.movedToDone.at)} by <strong>${escapeHtml(timeline.movedToDone.by)}</strong>`);
  }

  if (!parts.length) return '';
  return `<div class="handover">${parts.join(' · ')}</div>`;
};

const renderIssue = (issue, { withHandover = true } = {}) => `
  <div class="issue" style="--lane: ${laneColor(issue.bucket)}">
    <a class="issue__key" href="${escapeHtml(issue.url)}" target="_blank" rel="noreferrer">${escapeHtml(issue.key)}</a>
    <span class="issue__summary" title="${escapeHtml(issue.summary)}">${escapeHtml(issue.summary)}</span>
    <span class="issue__meta">
      <span class="status-pill" style="--lane: ${laneColor(issue.bucket)}">${escapeHtml(issue.status)}</span>
      <span class="age">${humanAge(issue.timeline.daysInCurrentStatus)} in status</span>
      ${issue.pullRequests.map(renderPullRequest).join('')}
      ${renderFlags(issue.flags)}
    </span>
    ${withHandover ? renderHandover(issue) : ''}
  </div>
`;

const renderDeveloper = (developer) => {
  const pills = LANE_ORDER.filter((bucket) => developer.totals[bucket] > 0)
    .map(
      (bucket) =>
        `<span class="mini-pill" style="--lane: ${laneColor(bucket)}">${developer.totals[bucket]} ${LANES[bucket].label}</span>`
    )
    .join('');

  const avatar = developer.avatar
    ? `<img class="developer__avatar" src="${escapeHtml(developer.avatar)}" alt="" />`
    : '<span class="developer__avatar"></span>';

  const body = developer.issues.length
    ? developer.issues.map((issue) => renderIssue(issue)).join('')
    : '<p class="developer__empty">No tickets in the current scope — worth asking what they picked up.</p>';

  return `
    <article class="developer">
      <header class="developer__header">
        ${avatar}
        <span class="developer__name">${escapeHtml(developer.name)}</span>
        <span class="developer__pills">${pills}</span>
      </header>
      <div class="developer__issues">${body}</div>
    </article>
  `;
};

const renderBoard = (columns) => `
  <div class="board">
    ${columns
      .map(
        (column) => `
      <section class="column" style="--lane: ${laneColor(column.bucket)}">
        <header class="column__header">
          <span>${LANES[column.bucket]?.label || column.bucket}</span>
          <span class="column__count">${column.issues.length}</span>
        </header>
        ${column.issues.map((issue) => renderIssue(issue, { withHandover: column.bucket !== 'todo' })).join('')}
      </section>
    `
      )
      .join('')}
  </div>
`;

const renderActivity = (activity) => {
  if (!activity.length) {
    return '<p class="placeholder">No status changes in this window. Either a quiet day, or the board needs updating.</p>';
  }

  const toQa = activity.filter((event) => event.isQaHandoff);
  const toDone = activity.filter((event) => event.isQaSignoff);
  const rest = activity.filter((event) => !event.isQaHandoff && !event.isQaSignoff);

  const renderEvent = (event) => `
    <div class="event" style="--lane: ${laneColor(event.toBucket)}">
      <a class="issue__key" href="${escapeHtml(event.url)}" target="_blank" rel="noreferrer">${escapeHtml(event.key)}</a>
      <span class="issue__summary" title="${escapeHtml(event.summary)}">${escapeHtml(event.summary)}</span>
      <span class="event__move">
        <span class="event__from">${escapeHtml(event.from || '—')}</span>
        <span>→</span>
        <span class="status-pill" style="--lane: ${laneColor(event.toBucket)}">${escapeHtml(event.to)}</span>
      </span>
      <span class="event__actor">by ${escapeHtml(event.by)}</span>
      <span class="event__time">${relativeTime(event.at)}</span>
    </div>
  `;

  const group = (title, events) =>
    events.length ? `<h2 class="section-title">${title} (${events.length})</h2>${events.map(renderEvent).join('')}` : '';

  return [
    group('Handed to QA', toQa),
    group('QA signed off to Done', toDone),
    group('Other moves', rest)
  ].join('');
};

const renderAttention = (issues) => {
  if (!issues.length) {
    return '<p class="placeholder">Nothing flagged. Board is healthy.</p>';
  }
  return issues.map((issue) => renderIssue(issue)).join('');
};

const renderTotals = (totals) =>
  LANE_ORDER.map(
    (bucket) => `
    <div class="total-card" style="--lane: ${laneColor(bucket)}">
      <div class="total-card__value">${totals[bucket] ?? 0}</div>
      <div class="total-card__label">${LANES[bucket].label}</div>
    </div>
  `
  ).join('');

/* ---------- top-level render ---------- */

const render = () => {
  if (state.error) {
    elements.view.innerHTML = `
      <div class="error">
        <strong>Could not load the board.</strong>
        <p>${escapeHtml(state.error.message)}</p>
        ${state.error.detail ? `<pre>${escapeHtml(JSON.stringify(state.error.detail, null, 2))}</pre>` : ''}
      </div>
    `;
    elements.boardMeta.textContent = 'Error';
    return;
  }

  if (!state.data) {
    elements.view.innerHTML = '<p class="placeholder">Loading the board…</p>';
    return;
  }

  const { data } = state;

  elements.teamName.textContent = data.team;
  elements.boardMeta.textContent = [
    data.sprint ? data.sprint.name : 'No active sprint',
    `${data.totals.all} tickets`,
    `updated ${relativeTime(data.generatedAt)}`
  ].join(' · ');

  elements.totals.innerHTML = renderTotals(data.totals);
  elements.attentionCount.textContent = data.attention.length;
  elements.attentionCount.dataset.empty = data.attention.length === 0;

  const views = {
    developers: () => data.developers.map(renderDeveloper).join(''),
    board: () => renderBoard(data.columns),
    activity: () => renderActivity(data.activity),
    attention: () => renderAttention(data.attention)
  };

  elements.view.innerHTML = views[state.view]();
};

/* ---------- data loading ---------- */

const load = async ({ force = false } = {}) => {
  state.loading = true;
  state.error = null;
  elements.refresh.disabled = true;
  elements.refresh.textContent = 'Refreshing…';

  try {
    const response = await fetch(`/api/standup?lookbackHours=${state.lookbackHours}&refresh=${force}`);
    const payload = await response.json();

    if (!response.ok) throw Object.assign(new Error(payload.error || 'Request failed'), { detail: payload.detail });

    state.data = payload;
  } catch (error) {
    state.error = { message: error.message, detail: error.detail };
  } finally {
    state.loading = false;
    elements.refresh.disabled = false;
    elements.refresh.textContent = 'Refresh';
    render();
  }
};

/* ---------- events ---------- */

const syncTabs = () => {
  for (const node of elements.tabs.querySelectorAll('.tab')) {
    node.classList.toggle('tab--active', node.dataset.view === state.view);
  }
};

elements.tabs.addEventListener('click', (event) => {
  const tab = event.target.closest('.tab');
  if (!tab) return;

  state.view = tab.dataset.view;
  location.hash = state.view;
  syncTabs();
  render();
});

window.addEventListener('hashchange', () => {
  const view = location.hash.slice(1);
  if (!VIEWS.includes(view) || view === state.view) return;
  state.view = view;
  syncTabs();
  render();
});

elements.lookback.addEventListener('change', () => {
  state.lookbackHours = Number(elements.lookback.value);
  syncTabs();
load();
});

elements.refresh.addEventListener('click', () => load({ force: true }));

syncTabs();
load();
