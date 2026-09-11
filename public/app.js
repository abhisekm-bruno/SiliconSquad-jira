const LANES = {
  todo: { label: 'To do', color: 'var(--todo)' },
  inProgress: { label: 'In progress', color: 'var(--in-progress)' },
  inReview: { label: 'In review', color: 'var(--in-review)' },
  qa: { label: 'QA', color: 'var(--qa)' },
  done: { label: 'Done', color: 'var(--done)' }
};

const LANE_ORDER = Object.keys(LANES);
const VIEWS = ['standup', 'board', 'activity', 'attention'];
const ALL = '__all__';

const state = {
  view: VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'standup',
  lookbackHours: 24,
  sprintId: '',
  developer: ALL,
  qa: ALL,
  lane: null,
  data: null,
  error: null
};

const elements = {
  teamName: document.getElementById('team-name'),
  boardMeta: document.getElementById('board-meta'),
  sprint: document.getElementById('sprint'),
  developer: document.getElementById('developer'),
  qa: document.getElementById('qa'),
  lookback: document.getElementById('lookback'),
  refresh: document.getElementById('refresh'),
  tabs: document.getElementById('tabs'),
  attentionCount: document.getElementById('attention-count'),
  totals: document.getElementById('totals'),
  view: document.getElementById('view')
};

/* ---------- helpers ---------- */

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const laneColor = (bucket) => LANES[bucket]?.color || 'var(--border)';

const relativeTime = (isoString) => {
  if (!isoString) return '';
  const minutes = (Date.now() - new Date(isoString).getTime()) / 60000;

  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${Math.round(minutes)}m ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / (60 * 24))}d ago`;
};

const humanAge = (days) => {
  if (days === null || days === undefined) return '—';
  if (days < 1) return `${Math.max(1, Math.round(days * 24))}h`;
  return `${Math.floor(days)}d`;
};

/** Keeps the table readable: long summaries get clipped with the full text on hover. */
const shortTitle = (summary, limit = 68) =>
  summary.length <= limit ? summary : `${summary.slice(0, limit - 1).trimEnd()}…`;

/* ---------- filtering ---------- */

const matchesPeople = (issue) => {
  const developerId = issue.assignee?.accountId || 'unassigned';
  if (state.developer !== ALL && developerId !== state.developer) return false;
  if (state.qa !== ALL && (issue.qaOwner?.name || 'unassigned') !== state.qa) return false;
  return true;
};

const visibleIssues = () => {
  if (!state.data) return [];

  return state.data.issues.filter((issue) => {
    const developerId = issue.assignee?.accountId || 'unassigned';
    if (state.developer !== ALL && developerId !== state.developer) return false;
    if (state.qa !== ALL && (issue.qaOwner?.name || 'unassigned') !== state.qa) return false;
    if (state.lane && issue.bucket !== state.lane) return false;
    return true;
  });
};

const countBuckets = (issues) =>
  LANE_ORDER.reduce((totals, bucket) => ({ ...totals, [bucket]: issues.filter((i) => i.bucket === bucket).length }), {
    all: issues.length
  });

/* ---------- cells ---------- */

const renderPullRequestCell = (issue) => {
  if (!issue.pullRequests.length) {
    const needsOne = issue.bucket === 'inReview' || issue.bucket === 'qa';
    return `<span class="pr-empty${needsOne ? ' pr-empty--warn' : ''}">${needsOne ? 'No PR' : '—'}</span>`;
  }

  return issue.pullRequests
    .map((pullRequest) => {
      const status = String(pullRequest.status || '').toLowerCase();
      const label = status === 'merged' ? 'Merged' : status === 'declined' ? 'Declined' : 'Open';
      const reviewers = pullRequest.reviewers || [];
      const approvals = reviewers.filter((reviewer) => reviewer.approved).length;
      const review = status === 'open' && reviewers.length ? ` ${approvals}/${reviewers.length}✓` : '';
      const idle =
        status === 'open' && pullRequest.lastUpdate
          ? `idle ${humanAge((Date.now() - new Date(pullRequest.lastUpdate).getTime()) / 86400000)}`
          : '';

      return `
        <a class="pr pr--${escapeHtml(status)}" href="${escapeHtml(pullRequest.url)}" target="_blank"
           rel="noreferrer" title="${escapeHtml(pullRequest.name || '')}">
          <span class="pr__status">${label}${review}</span>
          ${idle ? `<span class="pr__idle">${idle}</span>` : ''}
        </a>`;
    })
    .join('');
};

const renderEstimateCell = (issue) => {
  if (issue.estimateDays === null) return '<span class="estimate estimate--none">—</span>';

  const modifier = issue.overEstimate ? 'over' : issue.bucket === 'done' ? 'done' : 'on-track';
  const title = `${issue.activeDays.toFixed(1)}d active vs ${issue.estimateDays}d estimated`;

  return `<span class="estimate estimate--${modifier}" title="${escapeHtml(title)}">
    ${issue.estimateDays}d${issue.overEstimate ? ` <span class="estimate__over">+${(issue.activeDays - issue.estimateDays).toFixed(1)}</span>` : ''}
  </span>`;
};

const renderQaCell = (issue) => {
  if (!issue.qaOwner) {
    return issue.bucket === 'qa' ? '<span class="person person--pending">picking up</span>' : '<span class="person person--none">—</span>';
  }

  const signedOff = Boolean(issue.timeline.qaHandover);
  return `<span class="person${signedOff ? ' person--signed' : ''}"
    title="${signedOff ? 'Signed off to Done' : 'Last handled QA on this ticket'}">${escapeHtml(issue.qaOwner.name)}</span>`;
};

const renderFlags = (flags) =>
  flags.map((flag) => `<span class="flag flag--${escapeHtml(flag.severity)}">${escapeHtml(flag.label)}</span>`).join('');

/* ---------- the standup table ---------- */

const TABLE_HEAD = `
  <thead>
    <tr>
      <th class="col-key">Ticket</th>
      <th class="col-title">Title</th>
      <th class="col-person">Developer</th>
      <th class="col-person">QA</th>
      <th class="col-est">Est.</th>
      <th class="col-pr">PR</th>
      <th class="col-status">Status</th>
      <th class="col-age">Age</th>
    </tr>
  </thead>`;

const renderRow = (issue) => `
  <tr class="row" style="--lane: ${laneColor(issue.bucket)}">
    <td class="col-key">
      <a href="${escapeHtml(issue.url)}" target="_blank" rel="noreferrer">${escapeHtml(issue.key)}</a>
    </td>
    <td class="col-title" title="${escapeHtml(issue.summary)}">
      ${escapeHtml(shortTitle(issue.summary))}
      ${issue.flags.length ? `<div class="row__flags">${renderFlags(issue.flags)}</div>` : ''}
    </td>
    <td class="col-person">
      <span class="person${issue.assignee ? '' : ' person--none'}">${escapeHtml(issue.assignee?.name || 'Unassigned')}</span>
    </td>
    <td class="col-person">${renderQaCell(issue)}</td>
    <td class="col-est">${renderEstimateCell(issue)}</td>
    <td class="col-pr">${renderPullRequestCell(issue)}</td>
    <td class="col-status">
      <span class="status-pill" style="--lane: ${laneColor(issue.bucket)}">${escapeHtml(issue.status)}</span>
    </td>
    <td class="col-age">${humanAge(issue.timeline.daysInCurrentStatus)}</td>
  </tr>`;

/** One block per developer — the order the lead walks the call in. */
const renderDeveloperBlock = (developer) => {
  const totals = countBuckets(developer.issues);
  const pills = LANE_ORDER.filter((bucket) => totals[bucket] > 0)
    .map((bucket) => `<span class="mini-pill" style="--lane: ${laneColor(bucket)}">${totals[bucket]} ${LANES[bucket].label}</span>`)
    .join('');

  if (!developer.issues.length) {
    return `
      <section class="dev-block">
        <header class="dev-block__header">
          <span class="dev-block__name">${escapeHtml(developer.name)}</span>
        </header>
        <p class="dev-block__empty">No tickets in this sprint.</p>
      </section>`;
  }

  return `
    <section class="dev-block">
      <header class="dev-block__header">
        <span class="dev-block__name">${escapeHtml(developer.name)}</span>
        <span class="dev-block__pills">${pills}</span>
      </header>
      <div class="table-scroll">
        <table class="table">
          ${TABLE_HEAD}
          <tbody>${developer.issues.map(renderRow).join('')}</tbody>
        </table>
      </div>
    </section>`;
};

const renderStandup = () => {
  const issues = visibleIssues();

  if (!issues.length) {
    return '<p class="placeholder">No tickets for this selection. Try a different sprint or developer.</p>';
  }

  // A single developer selected: one flat table, no redundant heading.
  if (state.developer !== ALL) {
    return `
      <div class="table-scroll">
        <table class="table">
          ${TABLE_HEAD}
          <tbody>${issues.map(renderRow).join('')}</tbody>
        </table>
      </div>`;
  }

  const order = state.data.developers
    .map((developer) => ({
      ...developer,
      issues: issues.filter((issue) => (issue.assignee?.accountId || 'unassigned') === developer.accountId)
    }))
    .filter((developer) => developer.issues.length || developer.accountId !== 'unassigned');

  return order.map(renderDeveloperBlock).join('');
};

/* ---------- other views ---------- */

const renderBoard = () => {
  const issues = visibleIssues();

  return `
    <div class="board">
      ${LANE_ORDER.map((bucket) => {
        const laneIssues = issues.filter((issue) => issue.bucket === bucket);
        return `
          <section class="column" style="--lane: ${laneColor(bucket)}">
            <header class="column__header">
              <span>${LANES[bucket].label}</span>
              <span class="column__count">${laneIssues.length}</span>
            </header>
            ${laneIssues
              .map(
                (issue) => `
              <div class="card">
                <a class="card__key" href="${escapeHtml(issue.url)}" target="_blank" rel="noreferrer">${escapeHtml(issue.key)}</a>
                <div class="card__title" title="${escapeHtml(issue.summary)}">${escapeHtml(shortTitle(issue.summary, 60))}</div>
                <div class="card__meta">
                  <span class="person">${escapeHtml(issue.assignee?.name || 'Unassigned')}</span>
                  ${renderEstimateCell(issue)}
                </div>
                <div class="card__meta">${renderPullRequestCell(issue)}</div>
                ${issue.flags.length ? `<div class="row__flags">${renderFlags(issue.flags)}</div>` : ''}
              </div>`
              )
              .join('')}
          </section>`;
      }).join('')}
    </div>`;
};

const renderActivity = () => {
  const keys = new Set(visibleIssues().map((issue) => issue.key));
  const activity = state.data.activity.filter((event) => keys.has(event.key));

  if (!activity.length) {
    return '<p class="placeholder">No status changes in this window for the current selection.</p>';
  }

  const renderEvent = (event) => `
    <div class="event" style="--lane: ${laneColor(event.toBucket)}">
      <a class="card__key" href="${escapeHtml(event.url)}" target="_blank" rel="noreferrer">${escapeHtml(event.key)}</a>
      <span class="event__summary" title="${escapeHtml(event.summary)}">${escapeHtml(shortTitle(event.summary))}</span>
      <span class="event__move">
        <span class="event__from">${escapeHtml(event.from || '—')}</span>
        <span>→</span>
        <span class="status-pill" style="--lane: ${laneColor(event.toBucket)}">${escapeHtml(event.to)}</span>
      </span>
      <span class="event__actor">by ${escapeHtml(event.by)}</span>
      <span class="event__time">${relativeTime(event.at)}</span>
    </div>`;

  const group = (title, events) =>
    events.length ? `<h2 class="section-title">${title} (${events.length})</h2>${events.map(renderEvent).join('')}` : '';

  return [
    group('Handed to QA', activity.filter((event) => event.isQaHandoff)),
    group('QA signed off to Done', activity.filter((event) => event.isQaSignoff)),
    group('Other moves', activity.filter((event) => !event.isQaHandoff && !event.isQaSignoff))
  ].join('');
};

const renderAttention = () => {
  const issues = visibleIssues().filter((issue) => issue.flags.some((flag) => flag.severity === 'high'));

  if (!issues.length) return '<p class="placeholder">Nothing flagged. Board is healthy.</p>';

  return `
    <div class="table-scroll">
      <table class="table">
        ${TABLE_HEAD}
        <tbody>${issues.map(renderRow).join('')}</tbody>
      </table>
    </div>`;
};

const renderEmptyState = (data) => `
  <div class="empty-state">
    <h2>No tickets matched.</h2>
    <p>Jira answered fine, so this is a scope problem rather than a connection one. The query used was:</p>
    <pre>${escapeHtml(data.jql)}</pre>
    <p>Most likely one of these:</p>
    <ul>
      ${data.boardId ? '' : '<li><strong>No board found.</strong> The app looks one up from <code>projectKey</code>; if your team uses a board under a different project, set <code>boardId</code> explicitly. <code>npm run discover -- YOURKEY</code> prints the ids.</li>'}
      ${data.sprint ? '' : '<li><strong>No active sprint.</strong> Pick one from the Sprint dropdown, or set <code>"sprintScope": "none"</code> in config.json to show the whole project.</li>'}
      <li><strong>The <code>assignee in (...)</code> list is wrong or empty.</strong> Those must be Jira <em>accountIds</em>, not names or emails.</li>
      <li><strong>Wrong <code>projectKey</code></strong> for your team's board.</li>
    </ul>
    <p>Run <code>npm run check</code> — it narrows the query one clause at a time and prints which one empties the board.</p>
  </div>`;

/** Warns when the board is showing every team rather than just yours. */
const renderTeamNotice = (data) => {
  const { teamFilter } = data;
  if (!teamFilter) return '';

  if (!teamFilter.active) {
    return `
      <div class="notice notice--warn">
        <strong>Showing every team on this project.</strong>
        No team member could be resolved, so no assignee filter was applied. Add your teammates to
        <code>team.members</code> in config.json — a <code>name</code> or <code>email</code> is enough,
        the account id is looked up for you.
      </div>`;
  }

  if (teamFilter.unresolved.length) {
    return `
      <div class="notice">
        <strong>${teamFilter.resolved.length} of ${teamFilter.resolved.length + teamFilter.unresolved.length} team members matched.</strong>
        No Jira user found for ${escapeHtml(teamFilter.unresolved.join(', '))} — check the spelling, or use their email.
      </div>`;
  }

  return '';
};

/* ---------- selectors ---------- */

const fillSelect = (select, options, selected) => {
  select.innerHTML = options
    .map((option) => `<option value="${escapeHtml(option.value)}"${String(option.value) === String(selected) ? ' selected' : ''}>${escapeHtml(option.label)}</option>`)
    .join('');
};

const syncSelectors = (data) => {
  const sprintOptions = data.sprints?.length
    ? data.sprints.map((sprint) => ({
        value: sprint.id,
        label: sprint.state === 'active' ? `${sprint.name}  ·  active` : `${sprint.name}  ·  ${sprint.state}`
      }))
    : [{ value: '', label: data.boardId ? 'No sprints on this board' : 'No board found for this project' }];

  elements.sprint.disabled = !data.sprints?.length;

  fillSelect(elements.sprint, sprintOptions, state.sprintId || data.sprint?.id || '');

  const developers = [
    { value: ALL, label: `All developers (${data.issues.length})` },
    ...data.developers.map((developer) => ({
      value: developer.accountId,
      label: `${developer.name} (${developer.issues.length})`
    }))
  ];
  fillSelect(elements.developer, developers, state.developer);

  const qaNames = [...new Set(data.issues.map((issue) => issue.qaOwner?.name).filter(Boolean))].sort();
  fillSelect(
    elements.qa,
    [{ value: ALL, label: 'All QA' }, ...qaNames.map((name) => ({ value: name, label: name }))],
    state.qa
  );
};

/* ---------- render ---------- */

const syncTabs = () => {
  for (const node of elements.tabs.querySelectorAll('.tab')) {
    node.classList.toggle('tab--active', node.dataset.view === state.view);
  }
};

const render = () => {
  if (state.error) {
    elements.view.innerHTML = `
      <div class="error">
        <strong>Could not load the board.</strong>
        <p>${escapeHtml(state.error.message)}</p>
        ${state.error.detail ? `<pre>${escapeHtml(JSON.stringify(state.error.detail, null, 2))}</pre>` : ''}
      </div>`;
    elements.boardMeta.textContent = 'Error';
    return;
  }

  if (!state.data) {
    elements.view.innerHTML = '<p class="placeholder">Loading the board…</p>';
    return;
  }

  const { data } = state;
  const issues = visibleIssues();
  const totals = countBuckets(issues);

  elements.teamName.textContent = data.team;
  elements.boardMeta.textContent = [
    data.sprint ? data.sprint.name : 'No sprint selected',
    `${issues.length} of ${data.issues.length} tickets`,
    `updated ${relativeTime(data.generatedAt)}`
  ].join(' · ');

  const laneCounts = countBuckets(data.issues.filter(matchesPeople));
  elements.totals.innerHTML = LANE_ORDER.map(
    (bucket) => `
    <button type="button" class="lane-chip${state.lane === bucket ? ' lane-chip--active' : ''}"
            data-lane="${bucket}" style="--lane: ${laneColor(bucket)}"
            title="${state.lane === bucket ? 'Click to clear this filter' : `Show only ${LANES[bucket].label}`}">
      <span class="lane-chip__value">${laneCounts[bucket]}</span>
      <span class="lane-chip__label">${LANES[bucket].label}</span>
    </button>`
  ).join('');

  const flagged = issues.filter((issue) => issue.flags.some((flag) => flag.severity === 'high')).length;
  elements.attentionCount.textContent = flagged;
  elements.attentionCount.dataset.empty = flagged === 0;

  if (data.issues.length === 0) {
    elements.view.innerHTML = renderEmptyState(data);
    return;
  }

  const notice = renderTeamNotice(data);
  const views = { standup: renderStandup, board: renderBoard, activity: renderActivity, attention: renderAttention };
  elements.view.innerHTML = notice + views[state.view]();
  return;

};

/* ---------- data ---------- */

const load = async ({ force = false } = {}) => {
  state.error = null;
  elements.refresh.disabled = true;
  elements.refresh.textContent = 'Loading…';

  try {
    const params = new URLSearchParams({ lookbackHours: state.lookbackHours, refresh: String(force) });
    if (state.sprintId) params.set('sprintId', state.sprintId);

    const response = await fetch(`/api/standup?${params}`);
    const payload = await response.json();

    if (!response.ok) throw Object.assign(new Error(payload.error || 'Request failed'), { detail: payload.detail });

    state.data = payload;
    if (!state.sprintId && payload.sprint) state.sprintId = String(payload.sprint.id);

    // A developer or QA who has no tickets in the newly chosen sprint shouldn't
    // leave the board looking empty.
    const developerIds = new Set([ALL, ...payload.developers.map((developer) => developer.accountId)]);
    if (!developerIds.has(state.developer)) state.developer = ALL;

    const qaNames = new Set([ALL, ...payload.issues.map((issue) => issue.qaOwner?.name).filter(Boolean)]);
    if (!qaNames.has(state.qa)) state.qa = ALL;

    syncSelectors(payload);
  } catch (error) {
    state.error = { message: error.message, detail: error.detail };
  } finally {
    elements.refresh.disabled = false;
    elements.refresh.textContent = 'Refresh';
    render();
  }
};

/* ---------- events ---------- */

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

elements.sprint.addEventListener('change', () => {
  state.sprintId = elements.sprint.value;
  load();
});

// Developer and QA filter what is already loaded, so switching is instant.
elements.developer.addEventListener('change', () => {
  state.developer = elements.developer.value;
  render();
});

elements.qa.addEventListener('change', () => {
  state.qa = elements.qa.value;
  render();
});

elements.totals.addEventListener('click', (event) => {
  const chip = event.target.closest('.lane-chip');
  if (!chip) return;

  state.lane = state.lane === chip.dataset.lane ? null : chip.dataset.lane;
  render();
});

elements.lookback.addEventListener('change', () => {
  state.lookbackHours = Number(elements.lookback.value);
  load();
});

elements.refresh.addEventListener('click', () => load({ force: true }));

syncTabs();
load();
