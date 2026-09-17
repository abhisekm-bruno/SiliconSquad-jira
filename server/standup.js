import { mapWithConcurrency } from './jira.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const BUCKET_ORDER = ['todo', 'inProgress', 'inReview', 'qa', 'done'];

const normalise = (value) => String(value || '').trim().toLowerCase();

const daysBetween = (from, to = Date.now()) => (to - new Date(from).getTime()) / DAY_MS;

/** Maps a Jira status name onto one of our five standup lanes. */
const bucketFor = (workflow, statusName, statusCategoryKey) => {
  const target = normalise(statusName);

  for (const bucket of BUCKET_ORDER) {
    if ((workflow[bucket] || []).some((name) => normalise(name) === target)) return bucket;
  }

  // Unmapped status: fall back to Jira's own category so nothing silently vanishes.
  if (statusCategoryKey === 'done') return 'done';
  if (statusCategoryKey === 'indeterminate') return 'inProgress';
  return 'todo';
};

const isInBucket = (workflow, bucket, statusName) =>
  (workflow[bucket] || []).some((name) => normalise(name) === normalise(statusName));

/** Flattens an issue changelog into just its status transitions, oldest first. */
const statusTransitions = (histories) => {
  const transitions = [];

  for (const history of histories) {
    for (const item of history.items || []) {
      if (item.field !== 'status' && item.fieldId !== 'status') continue;
      transitions.push({
        from: item.fromString,
        to: item.toString,
        at: history.created,
        by: history.author?.displayName || 'Unknown',
        byAccountId: history.author?.accountId || null
      });
    }
  }

  return transitions.sort((a, b) => new Date(a.at) - new Date(b.at));
};

const lastTransitionInto = (transitions, workflow, bucket) =>
  [...transitions].reverse().find((transition) => isInBucket(workflow, bucket, transition.to)) || null;

const buildTimeline = (transitions, workflow, issueCreated, currentStatus) => {
  const enteredCurrentStatus =
    [...transitions].reverse().find((transition) => normalise(transition.to) === normalise(currentStatus))?.at ||
    issueCreated;

  const startedWork = transitions.find((transition) => isInBucket(workflow, 'inProgress', transition.to)) || null;
  const movedToReview = lastTransitionInto(transitions, workflow, 'inReview');
  const movedToQa = lastTransitionInto(transitions, workflow, 'qa');
  const movedToDone = lastTransitionInto(transitions, workflow, 'done');

  // The handover we care about in standup: QA signing a ticket off into Done.
  const qaHandover =
    movedToDone && isInBucket(workflow, 'qa', movedToDone.from)
      ? { at: movedToDone.at, by: movedToDone.by, fromStatus: movedToDone.from }
      : null;

  const qaCycleHours =
    movedToQa && movedToDone && new Date(movedToDone.at) > new Date(movedToQa.at)
      ? (new Date(movedToDone.at) - new Date(movedToQa.at)) / (60 * 60 * 1000)
      : null;

  return {
    enteredCurrentStatus,
    daysInCurrentStatus: Number(daysBetween(enteredCurrentStatus).toFixed(2)),
    startedWork,
    movedToReview,
    movedToQa,
    movedToDone,
    qaHandover,
    qaCycleHours: qaCycleHours === null ? null : Number(qaCycleHours.toFixed(1)),
    // How many times QA pushed it back out of a QA status — a re-open signal.
    qaBounces: transitions.filter(
      (transition) => isInBucket(workflow, 'qa', transition.from) && !isInBucket(workflow, 'done', transition.to)
    ).length
  };
};

/**
 * Roster names are written the short way people say them ("Shivang"), while
 * Jira stores the full display name, so either may be the prefix of the other.
 */
const matchesRoster = (name, roster) => {
  if (!roster.length) return true;

  const actor = normalise(name);
  return roster.some((member) => {
    const candidate = normalise(member);
    return actor === candidate || actor.startsWith(candidate) || candidate.startsWith(actor);
  });
};

/**
 * Who is QA on this ticket. Jira has no standard field for it, so unless the
 * project has one configured we infer it from the changelog: the person who
 * moved the ticket *out of* a QA status is the one who tested it. With a QA
 * roster configured, only those people count — a developer moving their own
 * ticket along is not a QA sign-off.
 */
const deriveQaOwner = (transitions, workflow, qaFieldValue, qaEngineers = []) => {
  if (qaFieldValue?.displayName) {
    return { name: qaFieldValue.displayName, accountId: qaFieldValue.accountId || null, source: 'field' };
  }

  const outOfQa = [...transitions]
    .reverse()
    .find((transition) => isInBucket(workflow, 'qa', transition.from) && matchesRoster(transition.by, qaEngineers));

  if (outOfQa) {
    return { name: outOfQa.by, accountId: outOfQa.byAccountId, source: 'transition' };
  }

  return null;
};

/**
 * Estimated days. Prefers an explicit time estimate, falls back to story points
 * converted at the team's own rate.
 */
const deriveEstimateDays = (rawFields, storyPoints, estimateConfig) => {
  const seconds = rawFields.timeoriginalestimate ?? rawFields.timeestimate ?? null;
  if (seconds) return Number((seconds / 3600 / estimateConfig.hoursPerDay).toFixed(2));

  if (typeof storyPoints === 'number') return Number((storyPoints * estimateConfig.pointsToDays).toFixed(2));

  return null;
};

/** Working days a ticket has been actively worked, excluding time in To Do. */
const activeDays = (transitions, workflow, issueCreated) => {
  const started = transitions.find((transition) => isInBucket(workflow, 'inProgress', transition.to));
  const finished = lastTransitionInto(transitions, workflow, 'done');
  const from = started ? new Date(started.at) : new Date(issueCreated);
  const to = finished ? new Date(finished.at) : new Date();

  return Number(Math.max(0, (to - from) / DAY_MS).toFixed(2));
};

const summarisePullRequest = (pullRequest) => ({
  id: pullRequest.id,
  name: pullRequest.name,
  url: pullRequest.url,
  status: pullRequest.status, // OPEN | MERGED | DECLINED
  author: pullRequest.author?.name || null,
  lastUpdate: pullRequest.lastUpdate || null,
  repository: pullRequest.repositoryName || pullRequest.source?.branch || null,
  reviewers: (pullRequest.reviewers || []).map((reviewer) => ({
    name: reviewer.name,
    approved: Boolean(reviewer.approved)
  }))
});

const computeFlags = (issue, thresholds) => {
  const flags = [];
  const { bucket, timeline, pullRequests, assignee } = issue;

  if (issue.blocked) flags.push({ id: 'blocked', label: 'Blocked', severity: 'high' });
  if (!assignee && bucket !== 'done') flags.push({ id: 'unassigned', label: 'Unassigned', severity: 'medium' });

  if (bucket === 'inProgress' && timeline.daysInCurrentStatus > thresholds.staleInProgressDays) {
    flags.push({
      id: 'stale-in-progress',
      label: `In progress ${Math.floor(timeline.daysInCurrentStatus)}d`,
      severity: 'medium'
    });
  }

  if (bucket === 'inReview' && timeline.daysInCurrentStatus > thresholds.staleInReviewDays) {
    flags.push({
      id: 'stale-review',
      label: `Awaiting review ${Math.floor(timeline.daysInCurrentStatus)}d`,
      severity: 'high'
    });
  }

  if (bucket === 'qa' && timeline.daysInCurrentStatus > thresholds.staleInQaDays) {
    flags.push({
      id: 'stale-qa',
      label: `Sitting in QA ${Math.floor(timeline.daysInCurrentStatus)}d`,
      severity: 'high'
    });
  }

  if ((bucket === 'inReview' || bucket === 'qa') && pullRequests.length === 0) {
    flags.push({ id: 'no-pr', label: 'No linked PR', severity: 'medium' });
  }

  const stalePr = pullRequests.find(
    (pullRequest) =>
      normalise(pullRequest.status) === 'open' &&
      pullRequest.lastUpdate &&
      daysBetween(pullRequest.lastUpdate) > thresholds.stalePrDays
  );
  if (stalePr) {
    flags.push({
      id: 'stale-pr',
      label: `PR idle ${Math.floor(daysBetween(stalePr.lastUpdate))}d`,
      severity: 'medium'
    });
  }

  if (issue.overEstimate) {
    flags.push({
      id: 'over-estimate',
      label: `${issue.activeDays.toFixed(1)}d vs ${issue.estimateDays}d estimate`,
      severity: 'medium'
    });
  }

  if (timeline.qaBounces > 0) {
    flags.push({
      id: 'qa-bounce',
      label: timeline.qaBounces === 1 ? 'Bounced from QA' : `Bounced from QA ×${timeline.qaBounces}`,
      severity: 'high'
    });
  }

  if (bucket === 'done' && pullRequests.some((pullRequest) => normalise(pullRequest.status) === 'open')) {
    flags.push({ id: 'done-open-pr', label: 'Done but PR still open', severity: 'high' });
  }

  return flags;
};

/**
 * Account IDs are the only thing Jira will filter assignees by, but nobody
 * knows theirs. So a member may be listed by email or name and we look the
 * account ID up once per process.
 */
const memberCache = new Map();

export const resolveTeamMembers = async (jira, config) => {
  const resolved = [];
  const unresolved = [];

  for (const member of config.team.members) {
    if (member.accountId) {
      resolved.push({ ...member });
      continue;
    }

    const query = member.email || member.name;
    if (!query) continue;

    if (memberCache.has(query)) {
      const cached = memberCache.get(query);
      if (cached) resolved.push({ ...member, accountId: cached.accountId, name: member.name || cached.displayName });
      else unresolved.push(member.name || query);
      continue;
    }

    let match = null;
    try {
      const candidates = await jira.findUsersByEmail(query);
      const normalisedQuery = query.trim().toLowerCase();

      match =
        candidates.find((user) => (user.emailAddress || '').toLowerCase() === normalisedQuery) ||
        candidates.find((user) => (user.displayName || '').toLowerCase() === normalisedQuery) ||
        candidates.find((user) => user.accountType === 'atlassian') ||
        candidates[0] ||
        null;
    } catch {
      match = null;
    }

    memberCache.set(query, match);

    if (match) resolved.push({ ...member, accountId: match.accountId, name: member.name || match.displayName });
    else unresolved.push(member.name || query);
  }

  return { resolved, unresolved };
};

/** Builds the JQL that scopes the board down to this one team. */
export const buildJql = (config, sprintClause, accountIds = []) => {
  const clauses = [];

  if (config.projectKey) clauses.push(`project = "${config.projectKey}"`);
  if (sprintClause) clauses.push(sprintClause);

  if (accountIds.length) {
    clauses.push(`assignee in (${accountIds.map((id) => `"${id}"`).join(', ')})`);
  }

  if (config.extraJql) clauses.push(`(${config.extraJql})`);

  // Keep the board light: everything open, plus recently-completed work so the
  // team can still see what shipped since the last standup.
  clauses.push(`(statusCategory != Done OR statusCategoryChangedDate >= -${config.doneLookbackDays}d)`);

  return `${clauses.join(' AND ')} ORDER BY updated DESC`;
};

/**
 * The board id is the one bit of config nobody knows offhand, so find it from
 * the project when it isn't set. Prefers a scrum board, since only those have
 * sprints.
 */
const resolveBoardId = async (jira, config) => {
  if (config.boardId) return config.boardId;
  if (!config.projectKey) return null;

  try {
    const { values = [] } = await jira.boards(config.projectKey);
    const scrum = values.find((board) => board.type === 'scrum');
    return (scrum || values[0])?.id ?? null;
  } catch {
    return null;
  }
};

const resolveSprintClause = async (jira, config, requestedSprintId) => {
  const boardId = await resolveBoardId(jira, config);
  if (!boardId) return { clause: null, sprint: null, sprints: [], boardId: null };

  let sprints = [];
  try {
    sprints = await jira.sprints(boardId);
  } catch {
    sprints = [];
  }

  // An explicit pick from the dropdown always wins over the configured scope.
  if (requestedSprintId) {
    const sprint = sprints.find((candidate) => String(candidate.id) === String(requestedSprintId));
    return { clause: `sprint = ${Number(requestedSprintId)}`, sprint: sprint || null, sprints, boardId };
  }

  if (config.sprintScope === 'none') return { clause: null, sprint: null, sprints, boardId };
  if (config.sprintScope === 'open') return { clause: 'sprint in openSprints()', sprint: null, sprints, boardId };

  const active = sprints.find((sprint) => sprint.state === 'active');
  if (!active) return { clause: null, sprint: null, sprints, boardId };

  return { clause: `sprint = ${active.id}`, sprint: active, sprints, boardId };
};

/** The team field comes back as a string, an object, or a list of either. */
const readTeamName = (value) => {
  if (!value) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (Array.isArray(value)) return readTeamName(value[0]);
  return value.name || value.title || value.value || value.displayName || null;
};

let fieldCache = null;

const jiraFields = async (jira) => {
  if (fieldCache) return fieldCache;
  try {
    fieldCache = await jira.fields();
  } catch {
    fieldCache = [];
  }
  return fieldCache;
};

const findStoryPointsFieldId = async (jira) => {
  const fields = await jiraFields(jira);
  return fields.find((field) => /story point/i.test(field.name || ''))?.id || null;
};

/**
 * Sites name the team field all sorts of things — "Team", "Team Assignment",
 * "Scrum Team" — and often carry several of them with only one filled in. So
 * collect every candidate and let the data decide which is real.
 */
const findTeamFieldCandidates = async (jira, config) => {
  const fields = await jiraFields(jira);

  if (config.teamFieldId) {
    const pinned = fields.find((field) => field.id === config.teamFieldId);
    return [pinned || { id: config.teamFieldId, name: config.teamFieldId }];
  }

  if (config.teamFieldName) {
    const wanted = config.teamFieldName.trim().toLowerCase();
    const named = fields.filter((field) => (field.name || '').trim().toLowerCase() === wanted);
    if (named.length) return named.map((field) => ({ id: field.id, name: field.name }));
  }

  return fields
    .filter((field) => /\bteams?\b/i.test(field.name || ''))
    .map((field) => ({ id: field.id, name: field.name }))
    // An exact "Team" is the likeliest, so try it before "Team Assignment" etc.
    .sort((a, b) => Number(/^team$/i.test(b.name.trim())) - Number(/^team$/i.test(a.name.trim())));
};

/** Of the candidates, the one actually populated on these tickets wins. */
const pickTeamField = (candidates, rawIssues) => {
  let best = null;

  for (const candidate of candidates) {
    const populated = rawIssues.filter((issue) => readTeamName(issue.fields[candidate.id])).length;
    if (populated > (best?.populated ?? 0)) best = { ...candidate, populated };
  }

  return best;
};

export const buildStandup = async (jira, config, { lookbackHours, sprintId }) => {
  const { clause: sprintClause, sprint, sprints, boardId } = await resolveSprintClause(jira, config, sprintId);
  const storyPointsFieldId = await findStoryPointsFieldId(jira);
  const teamCandidates = await findTeamFieldCandidates(jira, config);

  const { resolved: teamMembers, unresolved } = await resolveTeamMembers(jira, config);
  const accountIds = teamMembers.map((member) => member.accountId).filter(Boolean);
  const jql = buildJql(config, sprintClause, accountIds);
  const fields = [
    'summary',
    'status',
    'assignee',
    'priority',
    'issuetype',
    'labels',
    'created',
    'updated',
    'duedate',
    'parent',
    'timeoriginalestimate',
    'timeestimate',
    ...(storyPointsFieldId ? [storyPointsFieldId] : []),
    ...teamCandidates.map((candidate) => candidate.id),
    ...(config.qaFieldId ? [config.qaFieldId] : [])
  ];

  const rawIssues = await jira.search(jql, { fields });
  const teamField = pickTeamField(teamCandidates, rawIssues);

  const issues = await mapWithConcurrency(rawIssues, 5, async (raw) => {
    const [histories, pullRequests] = await Promise.all([
      jira.changelog(raw.key).catch(() => []),
      jira.pullRequests(raw.id, config.devStatusApplicationTypes).catch(() => [])
    ]);

    const transitions = statusTransitions(histories);
    const statusName = raw.fields.status?.name || 'Unknown';
    const bucket = bucketFor(config.workflow, statusName, raw.fields.status?.statusCategory?.key);
    const labels = raw.fields.labels || [];

    const issue = {
      id: raw.id,
      key: raw.key,
      url: `${jira.baseUrl}/browse/${raw.key}`,
      summary: raw.fields.summary,
      type: raw.fields.issuetype?.name || null,
      typeIcon: raw.fields.issuetype?.iconUrl || null,
      priority: raw.fields.priority?.name || null,
      status: statusName,
      statusCategory: raw.fields.status?.statusCategory?.key || null,
      bucket,
      labels,
      storyPoints: storyPointsFieldId ? raw.fields[storyPointsFieldId] ?? null : null,
      jiraTeam: teamField ? readTeamName(raw.fields[teamField.id]) : null,
      dueDate: raw.fields.duedate || null,
      parentKey: raw.fields.parent?.key || null,
      updated: raw.fields.updated,
      blocked: labels.some((label) => /block/i.test(label)) || /block/i.test(statusName),
      assignee: raw.fields.assignee
        ? {
            accountId: raw.fields.assignee.accountId,
            name: raw.fields.assignee.displayName,
            avatar: raw.fields.assignee.avatarUrls?.['24x24'] || null
          }
        : null,
      pullRequests: pullRequests.map(summarisePullRequest),
      transitions,
      timeline: buildTimeline(transitions, config.workflow, raw.fields.created, statusName),
      qaOwner: deriveQaOwner(
        transitions,
        config.workflow,
        config.qaFieldId ? raw.fields[config.qaFieldId] : null,
        config.qaEngineers
      ),
      activeDays: activeDays(transitions, config.workflow, raw.fields.created)
    };

    issue.estimateDays = deriveEstimateDays(raw.fields, issue.storyPoints, config.estimate);
    issue.overEstimate =
      issue.estimateDays !== null && issue.bucket !== 'done' && issue.activeDays > issue.estimateDays;

    issue.flags = computeFlags(issue, config.thresholds);
    return issue;
  });

  const teams = [...new Set(issues.map((issue) => issue.jiraTeam).filter(Boolean))].sort();

  return {
    generatedAt: new Date().toISOString(),
    team: config.team.name,
    teams,
    qaEngineers: config.qaEngineers,
    teamFieldFound: Boolean(teamField),
    teamFieldName: teamField?.name || null,
    teamFieldCandidates: teamCandidates.map((candidate) => candidate.name),
    defaultJiraTeam: config.team.jiraTeam || null,
    jql,
    sprint,
    sprints,
    boardId,
    teamFilter: {
      active: accountIds.length > 0,
      resolved: teamMembers.map((member) => ({ name: member.name, accountId: member.accountId })),
      unresolved
    },
    lookbackHours,
    jiraBaseUrl: jira.baseUrl,
    issues,
    developers: groupByDeveloper(issues, teamMembers),
    columns: groupByBucket(issues),
    activity: recentActivity(issues, config, lookbackHours),
    attention: issues.filter((issue) => issue.flags.some((flag) => flag.severity === 'high')),
    totals: countBuckets(issues)
  };
};

const countBuckets = (issues) =>
  BUCKET_ORDER.reduce(
    (totals, bucket) => ({ ...totals, [bucket]: issues.filter((issue) => issue.bucket === bucket).length }),
    { all: issues.length }
  );

const groupByBucket = (issues) =>
  BUCKET_ORDER.map((bucket) => ({
    bucket,
    issues: issues.filter((issue) => issue.bucket === bucket)
  }));

const groupByDeveloper = (issues, teamMembers) => {
  const byAccountId = new Map();

  // Seed from the team list so a developer with nothing assigned still shows
  // up — an empty column is itself a standup talking point.
  for (const member of teamMembers) {
    if (!member.accountId) continue;
    byAccountId.set(member.accountId, {
      accountId: member.accountId,
      name: member.name,
      avatar: null,
      issues: []
    });
  }

  for (const issue of issues) {
    const accountId = issue.assignee?.accountId || 'unassigned';
    if (!byAccountId.has(accountId)) {
      byAccountId.set(accountId, {
        accountId,
        name: issue.assignee?.name || 'Unassigned',
        avatar: issue.assignee?.avatar || null,
        issues: []
      });
    }
    const developer = byAccountId.get(accountId);
    if (!developer.avatar) developer.avatar = issue.assignee?.avatar || null;
    developer.issues.push(issue);
  }

  return [...byAccountId.values()]
    .map((developer) => ({
      ...developer,
      issues: developer.issues.sort((a, b) => BUCKET_ORDER.indexOf(a.bucket) - BUCKET_ORDER.indexOf(b.bucket)),
      totals: countBuckets(developer.issues)
    }))
    .sort((a, b) => {
      if (a.accountId === 'unassigned') return 1;
      if (b.accountId === 'unassigned') return -1;
      return b.issues.length - a.issues.length;
    });
};

/** The "since last standup" feed: every status move inside the lookback window. */
const recentActivity = (issues, config, lookbackHours) => {
  const since = Date.now() - lookbackHours * 60 * 60 * 1000;
  const events = [];

  for (const issue of issues) {
    for (const transition of issue.transitions) {
      if (new Date(transition.at).getTime() < since) continue;

      events.push({
        key: issue.key,
        url: issue.url,
        summary: issue.summary,
        assignee: issue.assignee?.name || 'Unassigned',
        from: transition.from,
        to: transition.to,
        at: transition.at,
        by: transition.by,
        toBucket: bucketFor(config.workflow, transition.to),
        isQaHandoff: isInBucket(config.workflow, 'qa', transition.to),
        isQaSignoff:
          isInBucket(config.workflow, 'done', transition.to) && isInBucket(config.workflow, 'qa', transition.from)
      });
    }
  }

  return events.sort((a, b) => new Date(b.at) - new Date(a.at));
};
