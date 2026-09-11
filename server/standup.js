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

/** Builds the JQL that scopes the board down to this one team. */
export const buildJql = (config, sprintClause) => {
  const clauses = [];

  if (config.projectKey) clauses.push(`project = "${config.projectKey}"`);
  if (sprintClause) clauses.push(sprintClause);

  const accountIds = config.team.members.map((member) => member.accountId).filter(Boolean);
  if (accountIds.length) {
    clauses.push(`assignee in (${accountIds.map((id) => `"${id}"`).join(', ')})`);
  }

  if (config.extraJql) clauses.push(`(${config.extraJql})`);

  // Keep the board light: everything open, plus recently-completed work so the
  // team can still see what shipped since the last standup.
  clauses.push(`(statusCategory != Done OR statusCategoryChangedDate >= -${config.doneLookbackDays}d)`);

  return `${clauses.join(' AND ')} ORDER BY updated DESC`;
};

const resolveSprintClause = async (jira, config) => {
  if (config.sprintScope === 'none' || !config.boardId) return { clause: null, sprint: null };

  if (config.sprintScope === 'open') return { clause: 'sprint in openSprints()', sprint: null };

  try {
    const { values = [] } = await jira.activeSprints(config.boardId);
    if (!values.length) return { clause: null, sprint: null };
    const [sprint] = values;
    return { clause: `sprint = ${sprint.id}`, sprint: { id: sprint.id, name: sprint.name, endDate: sprint.endDate } };
  } catch {
    return { clause: null, sprint: null };
  }
};

const findStoryPointsFieldId = async (jira) => {
  try {
    const fields = await jira.fields();
    const match = fields.find((field) => /story point/i.test(field.name || ''));
    return match?.id || null;
  } catch {
    return null;
  }
};

export const buildStandup = async (jira, config, { lookbackHours }) => {
  const { clause: sprintClause, sprint } = await resolveSprintClause(jira, config);
  const storyPointsFieldId = await findStoryPointsFieldId(jira);

  const jql = buildJql(config, sprintClause);
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
    ...(storyPointsFieldId ? [storyPointsFieldId] : [])
  ];

  const rawIssues = await jira.search(jql, { fields });

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
      timeline: buildTimeline(transitions, config.workflow, raw.fields.created, statusName)
    };

    issue.flags = computeFlags(issue, config.thresholds);
    return issue;
  });

  return {
    generatedAt: new Date().toISOString(),
    team: config.team.name,
    jql,
    sprint,
    lookbackHours,
    jiraBaseUrl: jira.baseUrl,
    issues,
    developers: groupByDeveloper(issues, config),
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

const groupByDeveloper = (issues, config) => {
  const byAccountId = new Map();

  // Seed from config so a developer with nothing assigned still shows up — an
  // empty column is itself a standup talking point.
  for (const member of config.team.members) {
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
