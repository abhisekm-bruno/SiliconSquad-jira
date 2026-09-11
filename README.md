# Team Standup Board

A small, dependency-free dashboard over **one team's** Jira board — built for running a daily
standup. It answers, at a glance:

- What is each developer working on right now?
- Which PRs are open, stale, or already merged for each ticket?
- **When did a ticket move to QA, and when did QA hand it over to Done — and who did it?**
- What changed since yesterday's standup?
- What needs attention before anyone leaves the call?

Your Jira has 5 teams; this scopes the board to your team only, via an assignee filter built
from the account IDs you list in `config.json`.

## Why it looks like this

| View | What it's for |
| --- | --- |
| **By developer** | The standup running order. One card per teammate, their tickets grouped by lane. A teammate with nothing assigned still gets a card — that's a talking point, not a gap. |
| **Board** | The familiar column view, scoped to your team. |
| **Since last standup** | Every status move in the window, split into **Handed to QA**, **QA signed off to Done**, and everything else. This is the "what moved yesterday" section. |
| **Needs attention** | Only the high-severity flags: blocked, stale in review/QA, bounced back from QA, done-but-PR-still-open. |

## Setup

Requires **Node 20+**. There are no npm dependencies — nothing to install.

### 1. Credentials

```bash
cp .env.example .env
```

Fill in your site and an API token from
<https://id.atlassian.com/manage-profile/security/api-tokens>:

```
JIRA_BASE_URL=https://yourcompany.atlassian.net
JIRA_EMAIL=you@yourcompany.com
JIRA_API_TOKEN=...
```

`.env` and `config.json` are both gitignored — your token never lands in the repo.

### 2. Config

```bash
cp config.example.json config.json
npm run discover
```

`discover` prints the projects you can see. Re-run it with your project key:

```bash
npm run discover -- SIL
```

That prints three things you need to paste into `config.json`:

- the **boardId** of your team's board,
- the **exact status names** on your workflow (so the `workflow` buckets match reality),
- every assignable user's **accountId** (so you can list your team's 5 members).

### 3. Run

```bash
npm start
```

Open <http://localhost:5123>. Each view is bookmarkable — `#activity` opens straight on
"Since last standup", which is handy as the tab you pin before the call.

## Configuration reference

```jsonc
{
  "team": {
    "name": "Silicon Squad",
    "members": [{ "name": "Abhisek M", "accountId": "5f8a…" }]   // accountId is what filters the board
  },

  "projectKey": "SIL",
  "boardId": 42,
  "sprintScope": "active",   // "active" = current sprint | "open" = all open sprints | "none" = whole project

  "workflow": {              // map YOUR status names onto the five standup lanes
    "todo":       ["To Do", "Backlog"],
    "inProgress": ["In Progress"],
    "inReview":   ["In Review", "Code Review"],
    "qa":         ["QA", "Ready for QA"],
    "done":       ["Done", "Closed"]
  },

  "thresholds": {            // how many days before a ticket gets flagged
    "staleInProgressDays": 3,
    "staleInReviewDays": 2,
    "staleInQaDays": 2,
    "stalePrDays": 2
  },

  "doneLookbackDays": 14,    // how far back completed tickets stay on the board
  "defaultLookbackHours": 24,// the "since last standup" window
  "extraJql": ""             // any extra JQL, ANDed in — e.g. "labels != tech-debt"
}
```

A status you forget to map still shows up: it falls back to Jira's own status category, so
nothing silently disappears from the board.

## How the QA tracking works

Jira does not expose "when did this reach QA" as a field, so the app derives it from each
issue's **changelog**:

- `movedToQa` — the most recent transition *into* any status in your `qa` bucket, with the actor.
- `qaHandover` — a transition into `done` **whose previous status was a QA status**. That is
  QA signing the ticket off, as opposed to a developer closing it directly.
- `qaCycleHours` — elapsed time between those two.
- `qaBounces` — how many times a ticket left QA *without* going to Done. Surfaces as a
  "Bounced from QA" flag, which is usually the most useful thing on the board.

## PR status

PRs come from Jira's own development panel (the "Development" box on an issue), so it uses the
GitHub↔Jira integration your project already has — **no GitHub token needed**. Each ticket shows
open / merged / declined plus approval count, and an open PR untouched for longer than
`stalePrDays` gets flagged.

That endpoint is an internal Jira API. If your site doesn't expose it, PR badges simply don't
render — the rest of the board is unaffected. If your team links Bitbucket instead of GitHub,
set `"devStatusApplicationTypes": ["bitbucket"]`.

## Notes

- Responses are cached for 30s; **Refresh** forces a fresh pull.
- The server holds your token and talks to Jira; the browser only ever sees the aggregated JSON.
  Nothing is sent anywhere except your own Jira site.
- It binds to localhost and has no auth of its own — run it locally, don't expose the port.

## Layout

```
server/
  index.js     HTTP server + /api/standup
  jira.js      Jira REST client (search, changelog, dev-status PRs)
  standup.js   bucketing, changelog → timeline, flags, grouping
  config.js    .env + config.json loading
public/        the dashboard (no build step, plain modules)
scripts/
  discover.js  prints boards, statuses and accountIds for config.json
```
