/**
 * Prints everything you need to fill in config.json: projects, boards, the real
 * status names on your workflow, and each teammate's accountId.
 *
 *   npm run discover              # projects + boards you can see
 *   npm run discover -- SIL       # statuses + assignable users for project SIL
 */
import { loadCredentials, loadEnv } from '../server/config.js';
import { JiraClient } from '../server/jira.js';

loadEnv();

const projectKey = process.argv[2];
const jira = new JiraClient(loadCredentials());

const heading = (text) => console.log(`\n\x1b[1m${text}\x1b[0m\n${'-'.repeat(text.length)}`);

const run = async () => {
  const me = await jira.myself();
  console.log(`Authenticated as ${me.displayName} <${me.emailAddress || 'email hidden'}>`);
  console.log(`Your own accountId: ${me.accountId}`);

  if (!projectKey) {
    heading('Projects');
    const { values = [] } = await jira.projects();
    for (const project of values) console.log(`  ${project.key.padEnd(10)} ${project.name}`);
    console.log('\nRe-run with your project key to see boards, statuses and teammates:');
    console.log('  npm run discover -- YOURKEY');
    return;
  }

  heading(`Boards in ${projectKey}`);
  const { values: boards = [] } = await jira.boards(projectKey);
  for (const board of boards) console.log(`  boardId ${String(board.id).padEnd(6)} ${board.name} (${board.type})`);
  if (!boards.length) console.log('  (none — leave boardId null and set sprintScope to "none")');

  heading(`Statuses in ${projectKey}`);
  const statusesByType = await jira.projectStatuses(projectKey);
  const seen = new Set();
  for (const issueType of statusesByType) {
    for (const status of issueType.statuses || []) {
      if (seen.has(status.name)) continue;
      seen.add(status.name);
      console.log(`  ${status.name.padEnd(28)} category: ${status.statusCategory?.key}`);
    }
  }
  console.log('\n  Copy these exact names into the "workflow" buckets in config.json.');

  heading(`Assignable users in ${projectKey}`);
  const users = await jira.assignableUsers(projectKey);
  for (const user of users) {
    console.log(`  ${(user.displayName || '').padEnd(28)} ${user.accountId}`);
  }
  console.log('\n  Copy the accountIds of your 5-team members into "team.members" in config.json.');
};

run().catch((error) => {
  console.error(`\nDiscovery failed: ${error.message}`);
  if (error.payload) console.error(error.payload);
  process.exitCode = 1;
});
