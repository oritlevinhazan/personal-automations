---
name: cronjob
description: Trigger a cron-job.org job manually for testing. Use when asked to "test run", "trigger the cron job", "run with dry_run", "run with skip_wait", or "test the enrollment script".
---

# cron-job.org Trigger Skill

Triggers the auto-enroll-arbox GitHub Actions workflow via cron-job.org's API.

## Configuration

- **Job ID:** `7794875`
- **API Key:** stored in `.env` as `CRONJOB_API_KEY`

Add this to `.env` before first use:
```
CRONJOB_API_KEY=your_key_here
```

## Use cases

Choose the right mode based on what you're testing:

| Goal | skip_wait | dry_run |
|---|---|---|
| Test full real run (actual enrollment at 16:00) | false | false |
| Test immediately, with real enrollment | true | false |
| Test immediately, no enrollment (safe) | true | true |
| Test schedule detection at 16:00, no enrollment | false | true |

## Trigger a job

Load `.env` and call the cron-job.org API to trigger job `7794875`:

```bash
source .env

# Edit these two variables before running:
SKIP_WAIT=true   # true = run immediately; false = wait for 16:00
DRY_RUN=true     # true = no actual enrollment; false = real enrollment

curl -s -X POST "https://api.cron-job.org/jobs/7794875/run" \
  -H "Authorization: Bearer $CRONJOB_API_KEY" \
  -H "Content-Type: application/json"
```

> **Note:** cron-job.org triggers the job as configured — it does not pass `skip_wait`/`dry_run` values directly. To change those, update the workflow dispatch inputs in the GitHub Actions workflow, or trigger GitHub directly with the desired inputs (see below).

## Trigger GitHub Actions directly (with inputs)

To pass `skip_wait` and `dry_run` values explicitly, trigger GitHub Actions directly using the GitHub MCP or this curl:

```bash
source .env

curl -s -X POST \
  -H "Authorization: Bearer $GITHUB_PERSONAL_ACCESS_TOKEN" \
  -H "Accept: application/vnd.github.v3+json" \
  "https://api.github.com/repos/oritlevinhazan/personal-automations/actions/workflows/main.yml/dispatches" \
  -d "{\"ref\": \"master\", \"inputs\": {\"skip_wait\": \"$SKIP_WAIT\", \"dry_run\": \"$DRY_RUN\"}}"
```

The `GITHUB_PERSONAL_ACCESS_TOKEN` is already in `.mcp.json` — copy it to `.env` as well if using curl directly.

## Default recommendation for this project

When asked to "test" without further context, use:
- `skip_wait=true`, `dry_run=true` — runs immediately, no real enrollment, safe to trigger anytime.

When asked to "do a real test run":
- `skip_wait=true`, `dry_run=false` — triggers immediately and actually enrolls if classes are available.
