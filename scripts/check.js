/**
 * Narrows the standup JQL one clause at a time and prints the count after each,
 * so you can see exactly which clause empties the board.
 *
 *   npm run check
 */
import { loadConfig, loadCredentials, loadEnv } from '../server/config.js';
import { JiraClient } from '../server/jira.js';

loadEnv();

const config = loadConfig();
const jira = new JiraClient(loadCredentials());

const count = async (label, jql) => {
  try {
    const issues = await jira.search(jql, { fields: ['summary'], pageSize: 100, maxIssues: 200 });
    const verdict = issues.length === 0 ? '  <-- empties here' : '';
    console.log(`  ${String(issues.length).padStart(4)}  ${label}${verdict}`);
    console.log(`        ${jql}`);
    return issues;
  } catch (error) {
    console.log(`   ERR  ${label}`);
    console.log(`        ${jql}`);
    console.log(`        ${JSON.stringify(error.payload?.errorMessages || error.payload || error.message)}`);
    return null;
  }
};

const run = async () => {
  const me = await jira.myself();
  console.log(`\nAuthenticated as ${me.displayName} (${me.accountId})`);

  console.log(`\nConfig: project=${config.projectKey || '(none)'} board=${config.boardId ?? '(none)'} sprintScope=${config.sprintScope}`);

  const accountIds = config.team.members.map((member) => member.accountId).filter(Boolean);
  console.log(`Team members with an accountId: ${accountIds.length} of ${config.team.members.length}`);
  if (accountIds.length === 0) {
    console.log('  !! No accountIds set, so the board is NOT filtered to your team yet.');
  }

  if (config.boardId) {
    try {
      const { values = [] } = await jira.activeSprints(config.boardId);
      console.log(`Active sprints on board ${config.boardId}: ${values.length ? values.map((s) => `${s.name} (id ${s.id})`).join(', ') : 'none'}`);
      if (!values.length) console.log('  !! No active sprint: set "sprintScope": "none" to show the whole project.');
    } catch (error) {
      console.log(`Active sprints on board ${config.boardId}: lookup failed (${error.status ?? error.message})`);
    }
  }

  console.log('\nNarrowing the query one clause at a time:\n');

  if (!config.projectKey) {
    console.log('  (no projectKey set, skipping project checks)');
    return;
  }

  const project = `project = "${config.projectKey}"`;
  const everything = await count('project only', project);
  if (everything === null) return;

  await count('project + open only', `${project} AND statusCategory != Done`);

  await count(
    'project + standup window',
    `${project} AND (statusCategory != Done OR statusCategoryChangedDate >= -${config.doneLookbackDays}d)`
  );

  if (accountIds.length) {
    await count(
      'project + your team',
      `${project} AND assignee in (${accountIds.map((id) => `"${id}"`).join(', ')})`
    );
  }

  if (config.boardId && config.sprintScope !== 'none') {
    await count('project + open sprints', `${project} AND sprint in openSprints()`);
  }

  if (everything?.length) {
    console.log('\nWho actually has tickets in this project:\n');
    const issues = await jira.search(project, { fields: ['assignee', 'status'], maxIssues: 200 });
    const tally = new Map();
    for (const issue of issues) {
      const assignee = issue.fields.assignee;
      const key = assignee ? `${assignee.displayName}  ${assignee.accountId}` : 'Unassigned';
      tally.set(key, (tally.get(key) || 0) + 1);
    }
    for (const [who, total] of [...tally].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(total).padStart(4)}  ${who}`);
    }

    console.log('\nTeam-ish fields and what they actually hold:\n');
    const allFields = await jira.fields();
    const teamFields = allFields.filter((field) => /\bteams?\b/i.test(field.name || ''));

    if (!teamFields.length) {
      console.log('  (no field with "team" in its name — scope by team.members instead)');
    } else {
      const sample = await jira.search(project, {
        fields: teamFields.map((field) => field.id),
        maxIssues: 100
      });

      for (const field of teamFields) {
        const values = new Set();
        for (const issue of sample) {
          const raw = issue.fields[field.id];
          const name =
            typeof raw === 'string' ? raw : Array.isArray(raw) ? raw[0]?.name : raw?.name || raw?.title || raw?.value;
          if (name) values.add(name);
        }
        console.log(`  ${(field.name || '').padEnd(24)} ${field.id.padEnd(22)} ${values.size ? [...values].join(', ') : '(empty on every sampled issue)'}`);
      }
      console.log('\n  Put the populated one in config.json as "teamFieldName", and your team as team.jiraTeam.');
    }

    console.log('\nStatus names in use (copy these into "workflow"):\n');
    const statuses = new Set(issues.map((issue) => issue.fields.status?.name).filter(Boolean));
    for (const status of statuses) console.log(`  ${status}`);
  }
};

run().catch((error) => {
  console.error(`\nCheck failed: ${error.message}`);
  if (error.payload) console.error(JSON.stringify(error.payload, null, 2));
  process.exitCode = 1;
});
