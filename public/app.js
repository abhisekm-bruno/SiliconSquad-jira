const LANES = {
  todo: { label: 'To do', color: 'var(--todo)' },
  inProgress: { label: 'In progress', color: 'var(--in-progress)' },
  inReview: { label: 'In review', color: 'var(--in-review)' },
  qa: { label: 'QA', color: 'var(--qa)' },
  done: { label: 'Done', color: 'var(--done)' }
};

const LANE_ORDER = Object.keys(LANES);

const LOADING_MESSAGES = [
  'Pretending this will be a short meeting…',
  'Looking for tickets hiding in QA…',
  'Asking Jira what everyone did yesterday…',
  'Finding out who forgot to update their status…'
];

// Start somewhere random, then cycle, so you never get the same line twice running.
let loadingCursor = Math.floor(Math.random() * LOADING_MESSAGES.length);
let loadingMessage = LOADING_MESSAGES[loadingCursor];

const nextLoadingMessage = () => {
  loadingCursor = (loadingCursor + 1) % LOADING_MESSAGES.length;
  loadingMessage = LOADING_MESSAGES[loadingCursor];
  return loadingMessage;
};
const VIEWS = ['standup', 'attention'];
const ALL = '__all__';

const state = {
  view: VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'standup',
  lookbackHours: 24,
  sprintId: '',
  team: ALL,
  person: ALL,
  lane: null,
  data: null,
  error: null
};

const elements = {
  teamName: document.getElementById('team-name'),
  boardMeta: document.getElementById('board-meta'),
  team: document.getElementById('team'),
  sprint: document.getElementById('sprint'),
  person: document.getElementById('person'),
  lookback: document.getElementById('lookback'),
  refresh: document.getElementById('refresh'),
  theme: document.getElementById('theme'),
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

/** Everything the chosen team owns — the pool the people dropdowns come from. */
const teamIssues = () => {
  if (!state.data) return [];
  if (state.team === ALL) return state.data.issues;

  return state.data.issues.filter((issue) => issue.jiraTeam === state.team);
};

/**
 * One picker holds both roles, so the selected value carries which role it is:
 * "dev:<accountId>" or "qa:<name>".
 */
const matchesPeople = (issue) => {
  if (state.person === ALL) return true;

  const [role, ...rest] = state.person.split(':');
  const value = rest.join(':');

  if (role === 'dev') return (issue.assignee?.accountId || 'unassigned') === value;
  if (role === 'qa') return (issue.qaOwner?.name || '').toLowerCase().startsWith(value.toLowerCase());
  return true;
};

const visibleIssues = () =>
  teamIssues().filter((issue) => {
    if (!matchesPeople(issue)) return false;
    if (state.lane && issue.bucket !== state.lane) return false;
    return true;
  });

/** Developers with tickets in the current team, busiest first. */
const developersInScope = () => {
  const byAccountId = new Map();

  for (const issue of teamIssues()) {
    const accountId = issue.assignee?.accountId || 'unassigned';
    if (!byAccountId.has(accountId)) {
      byAccountId.set(accountId, { accountId, name: issue.assignee?.name || 'Unassigned', issues: [] });
    }
    byAccountId.get(accountId).issues.push(issue);
  }

  // Configured teammates with nothing assigned still deserve a turn in the call.
  if (state.team === ALL) {
    for (const member of state.data?.teamFilter?.resolved || []) {
      if (!byAccountId.has(member.accountId)) {
        byAccountId.set(member.accountId, { accountId: member.accountId, name: member.name, issues: [] });
      }
    }
  }

  return [...byAccountId.values()].sort((a, b) => {
    if (a.accountId === 'unassigned') return 1;
    if (b.accountId === 'unassigned') return -1;
    return b.issues.length - a.issues.length;
  });
};

const qaInScope = () => {
  const found = teamIssues().map((issue) => issue.qaOwner?.name).filter(Boolean);
  const roster = state.data?.qaEngineers || [];

  // Show every QA on the roster, so the lead can pick one that has nothing yet.
  const names = roster.length
    ? [...roster, ...found.filter((name) => !roster.some((member) => name.toLowerCase().startsWith(member.toLowerCase())))]
    : found;

  return [...new Set(names)].sort();
};

/** Ticket counts per QA, for the dropdown labels. */
const qaCount = (name) =>
  teamIssues().filter((issue) => (issue.qaOwner?.name || '').toLowerCase().startsWith(name.toLowerCase())).length;

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
      const number = /\/pull\/(\d+)/.exec(pullRequest.url || '')?.[1];

      // A PR found in the description has no state until GitHub answers.
      if (!status) {
        return `<a class="pr pr--unknown" href="${escapeHtml(pullRequest.url)}" target="_blank" rel="noreferrer"
          title="Linked in the ticket description. Add GITHUB_TOKEN to .env to show its state.">
          <span class="pr__status">PR #${escapeHtml(number || '?')}</span>
        </a>`;
      }

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
    return issue.bucket === 'qa'
      ? '<div class="person-qa person-qa--pending">QA · picking up</div>'
      : '';
  }

  const signedOff = Boolean(issue.timeline.qaHandover);
  return `<div class="person-qa${signedOff ? ' person-qa--signed' : ''}"
    title="${signedOff ? 'Signed off to Done' : 'Last handled QA on this ticket'}">QA · ${escapeHtml(issue.qaOwner.name)}</div>`;
};

const renderFlags = (flags) =>
  flags.map((flag) => `<span class="flag flag--${escapeHtml(flag.severity)}">${escapeHtml(flag.label)}</span>`).join('');

/* ---------- the standup table ---------- */

/** The Est. column is dead weight on a board that tracks no estimates. */
let showEstimates = true;

const tableHead = () => `
  <thead>
    <tr>
      <th class="col-key">Ticket</th>
      <th class="col-title">Title</th>
      <th class="col-people">Dev / QA</th>
      ${showEstimates ? '<th class="col-est">Est.</th>' : ''}
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
    <td class="col-people">
      <div class="person${issue.assignee ? '' : ' person--none'}">${escapeHtml(issue.assignee?.name || 'Unassigned')}</div>
      ${renderQaCell(issue)}
    </td>
    ${showEstimates ? `<td class="col-est">${renderEstimateCell(issue)}</td>` : ''}
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
          ${tableHead()}
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
  if (state.person !== ALL) {
    return `
      <div class="table-scroll">
        <table class="table">
          ${tableHead()}
          <tbody>${issues.map(renderRow).join('')}</tbody>
        </table>
      </div>`;
  }

  const order = developersInScope()
    .map((developer) => ({
      ...developer,
      issues: issues.filter((issue) => (issue.assignee?.accountId || 'unassigned') === developer.accountId)
    }))
    .filter((developer) => developer.issues.length || developer.accountId !== 'unassigned');

  return order.map(renderDeveloperBlock).join('');
};

/* ---------- other views ---------- */

const renderAttention = () => {
  const issues = visibleIssues().filter((issue) => issue.flags.some((flag) => flag.severity === 'high'));

  if (!issues.length) return '<p class="placeholder">Nothing flagged. Board is healthy.</p>';

  return `
    <div class="table-scroll">
      <table class="table">
        ${tableHead()}
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

  // A Team picked from the dropdown already scopes the board.
  if (state.team !== ALL) return '';

  if (data.teams?.length) {
    return `
      <div class="notice">
        <strong>Showing all ${data.teams.length} teams</strong>, read from <code>${escapeHtml(data.teamFieldName)}</code>.
        Pick yours from the dropdown, or set <code>"jiraTeam": "${escapeHtml(data.teams[0])}"</code> under
        <code>team</code> in config.json so it opens there every morning.
      </div>`;
  }

  if (!data.qaEngineers?.length) {
    return `
      <div class="notice">
        <strong>QA column is showing whoever moved each ticket</strong>, which includes developers.
        Add a top-level <code>"qaEngineers": ["Abhisek M", "Shivang"]</code> to config.json to restrict it
        to your QA engineers.
      </div>`;
  }

  if (data.teamFieldCandidates?.length) {
    return `
      <div class="notice notice--warn">
        <strong>No team is set on these tickets.</strong>
        Found ${data.teamFieldCandidates.length} team-ish field(s) — ${escapeHtml(data.teamFieldCandidates.join(', '))} —
        but none carried a value. Pin the right one with <code>"teamFieldName": "Team Assignment"</code> in config.json,
        or run <code>npm run check</code> to see what each one holds.
      </div>`;
  }

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

const renderOption = (option, selected) =>
  `<option value="${escapeHtml(option.value)}"${String(option.value) === String(selected) ? ' selected' : ''}>${escapeHtml(option.label)}</option>`;

const fillSelect = (select, options, selected) => {
  select.innerHTML = options.map((option) => renderOption(option, selected)).join('');
};

/** Same, but with <optgroup> headings — [{ label, options }]. */
const fillGroupedSelect = (select, groups, selected) => {
  select.innerHTML = groups
    .filter((group) => group.options.length)
    .map(
      (group) =>
        `<optgroup label="${escapeHtml(group.label)}">${group.options.map((option) => renderOption(option, selected)).join('')}</optgroup>`
    )
    .join('');
};

const syncSelectors = (data) => {
  if (data.sprints?.length) {
    const asOption = (sprint) => ({ value: sprint.id, label: sprint.name });
    const inState = (wanted) => data.sprints.filter((sprint) => sprint.state === wanted).map(asOption);

    // Grouped, because a flat list with a dozen backlog buckets in it is
    // hard to pick a real sprint out of.
    fillGroupedSelect(
      elements.sprint,
      [
        { label: 'Current sprint', options: inState('active') },
        { label: 'Upcoming', options: inState('future') },
        { label: 'Finished', options: inState('closed') }
      ],
      state.sprintId || data.sprint?.id || ''
    );
  } else {
    fillSelect(
      elements.sprint,
      [{ value: '', label: data.boardId ? 'No sprints on this board' : 'No board found for this project' }],
      ''
    );
  }

  elements.sprint.disabled = !data.sprints?.length;

  const teamOptions = data.teams?.length
    ? [{ value: ALL, label: `All teams (${data.issues.length})` }, ...data.teams.map((team) => ({
        value: team,
        label: `${team} (${data.issues.filter((issue) => issue.jiraTeam === team).length})`
      }))]
    : [{ value: ALL, label: data.teamFieldCandidates?.length ? 'No team set on these tickets' : 'No team field on this site' }];

  fillSelect(elements.team, teamOptions, state.team);
  elements.team.disabled = !data.teams?.length;

  // Name the actual field, so it's obvious which one the board is reading.
  const teamLabel = document.querySelector('#team')?.closest('.picker')?.querySelector('.picker__label');
  if (teamLabel) teamLabel.textContent = data.teamFieldName || 'Team';

  const scoped = teamIssues();

  fillGroupedSelect(
    elements.person,
    [
      { label: 'Everyone', options: [{ value: ALL, label: `Everyone (${scoped.length})` }] },
      {
        label: 'Developers',
        options: developersInScope().map((developer) => ({
          value: `dev:${developer.accountId}`,
          label: `${developer.name} (${developer.issues.length})`
        }))
      },
      {
        label: 'QA',
        options: qaInScope().map((name) => ({ value: `qa:${name}`, label: `${name} (${qaCount(name)})` }))
      }
    ],
    state.person
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
    elements.view.innerHTML = `<p class="placeholder">${escapeHtml(loadingMessage)}</p>`;
    return;
  }

  const { data } = state;
  const issues = visibleIssues();
  const totals = countBuckets(issues);

  showEstimates = issues.some((issue) => issue.estimateDays !== null);

  elements.teamName.textContent = state.team === ALL ? data.team : state.team;
  elements.boardMeta.textContent = [
    data.sprint ? data.sprint.name : 'No sprint selected',
    `${issues.length} of ${data.issues.length} tickets`,
    `updated ${relativeTime(data.generatedAt)}`
  ].join(' · ');

  const laneCounts = countBuckets(teamIssues().filter(matchesPeople));
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
  const views = { standup: renderStandup, attention: renderAttention };
  elements.view.innerHTML = notice + views[state.view]();
  return;

};

/* ---------- remembering the lead's picks ---------- */

const STORAGE_KEY = 'standup-selection';

const remember = () => {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ team: state.team, sprintId: state.sprintId, person: state.person })
    );
  } catch {
    // A locked-down browser just means the picks don't persist; not worth failing over.
  }
};

const recall = () => {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    if (saved.team) state.team = saved.team;
    if (saved.sprintId) state.sprintId = saved.sprintId;
    if (saved.person) state.person = saved.person;
  } catch {
    // Ignore anything unparseable and start from defaults.
  }
};

/* ---------- data ---------- */

const load = async ({ force = false } = {}) => {
  state.error = null;
  elements.refresh.disabled = true;
  elements.refresh.textContent = 'Loading…';

  if (!state.data) elements.view.innerHTML = `<p class="placeholder">${escapeHtml(nextLoadingMessage())}</p>`;

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
    // config.json can name the team, so the board opens on it without a click.
    if (state.team === ALL && payload.defaultJiraTeam && payload.teams?.includes(payload.defaultJiraTeam)) {
      state.team = payload.defaultJiraTeam;
    }
    if (state.team !== ALL && !payload.teams?.includes(state.team)) state.team = ALL;

    // Someone with no tickets in the newly chosen sprint shouldn't leave the
    // board looking empty.
    const selectable = new Set([
      ALL,
      ...payload.issues.map((issue) => `dev:${issue.assignee?.accountId || 'unassigned'}`),
      ...(payload.qaEngineers || []).map((name) => `qa:${name}`),
      ...payload.issues.map((issue) => (issue.qaOwner ? `qa:${issue.qaOwner.name}` : null)).filter(Boolean)
    ]);
    if (!selectable.has(state.person)) state.person = ALL;

    syncSelectors(payload);
  } catch (error) {
    state.error = { message: error.message, detail: error.detail };
  } finally {
    elements.refresh.disabled = false;
    elements.refresh.textContent = 'Refresh';
    render();
  }
};

/* ---------- theme ---------- */

const applyTheme = (theme) => {
  if (theme === 'dark') document.documentElement.dataset.theme = 'dark';
  else delete document.documentElement.dataset.theme;

  elements.theme.textContent = theme === 'dark' ? '☀' : '☾';
  elements.theme.title = theme === 'dark' ? 'Switch to light' : 'Switch to dark';

  try {
    localStorage.setItem('standup-theme', theme);
  } catch {
    // Not persisting the theme is survivable.
  }
};

elements.theme.addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
});

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

elements.team.addEventListener('change', () => {
  state.team = elements.team.value;
  state.person = ALL;
  remember();
  syncSelectors(state.data);
  render();
});

elements.sprint.addEventListener('change', () => {
  state.sprintId = elements.sprint.value;
  remember();
  load();
});

// The person picker filters what is already loaded, so switching is instant.
elements.person.addEventListener('change', () => {
  state.person = elements.person.value;
  remember();
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

recall();
applyTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
syncTabs();
load();
