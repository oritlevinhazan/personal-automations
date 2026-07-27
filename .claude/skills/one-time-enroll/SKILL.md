---
name: one-time-enroll
description: Create a one-time Arbox enrollment automation for a specific date and time slot, including cron-job.org scheduling and Alertzy notifications
---

# One-Time Arbox Enrollment Skill

Use this when the user asks to register for a specific class on a specific date outside the regular Thursday flow.

## Gather from the user before starting

- **Target date** (e.g. "tomorrow", "Monday Jul 28")
- **Primary slot** — the time to try first (e.g. 08:30)
- **Trigger time** — when to attempt enrollment (e.g. "at 20:30 tonight")
- **Fallback slot** (optional) — a later time to try if the primary is full (e.g. 09:30 at 21:30)
- Confirm the day of week so `getNextXxxDate()` logic is correct

## Checklist

### 1. Write the script

Create `arbox/one-time-<descriptive-name>.js` (e.g. `one-time-tuesday.js`).

Key structure:
- `SLOT` env var selects which time to attempt (`0830`, `0930`, etc.)
- `TIME_MAP` maps slot codes to display times (`"0830" → "08:30"`)
- Login, fetch schedule for the target date, find a strength/power class at the target time
- If `SLOT` is the fallback slot:
  1. Check `booking_option === "cancelScheduleUser"` on the primary slot — exit if already enrolled
  2. Check if the primary slot now has `free > 0` — grab it if so
  3. Only then try the fallback slot
- Send a **separate Alertzy notification per attempt** (not one consolidated message)
- Add crash-safe `process.exit(0)` on all handled outcomes; let unhandled errors propagate so the workflow's `if: failure()` step fires

Use `arbox/one-time-tuesday.js` as a reference implementation.

### 2. Create the workflow

Create `.github/workflows/one-time-<name>.yml`.

```yaml
name: One-Time <Name> Enrollment

on:
  workflow_dispatch:
    inputs:
      slot:
        description: 'Time slot: 0830, 0930, etc.'
        required: true
        default: '0830'
      dry_run:
        required: false
        default: 'false'

jobs:
  enroll:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      - run: npm install
      - name: Run enrollment
        env:
          ARBOX_USER_EMAIL: ${{ secrets.ARBOX_USER_EMAIL }}
          ARBOX_USER_PASSWORD: ${{ secrets.ARBOX_USER_PASSWORD }}
          ALERTZY_ACCOUNT_KEY: ${{ secrets.ALERTZY_ACCOUNT_KEY }}
          SLOT: ${{ github.event.inputs.slot }}
          DRY_RUN: ${{ github.event.inputs.dry_run || 'false' }}
        run: node arbox/one-time-<name>.js
      - name: Notify on crash
        if: failure()
        env:
          ALERTZY_ACCOUNT_KEY: ${{ secrets.ALERTZY_ACCOUNT_KEY }}
        run: |
          node -e "
            import('../shared/push-notification.js').then(m =>
              m.sendPushNotification(
                process.env.ALERTZY_ACCOUNT_KEY,
                '⚠️ שגיאה בסקריפט',
                'הסקריפט קרס עבור סלוט ${{ github.event.inputs.slot }} — בדקי GitHub Actions'
              )
            )
          "
```

### 3. Test with a dry run

```bash
source .env && SLOT=0830 DRY_RUN=true node arbox/one-time-<name>.js
source .env && SLOT=0930 DRY_RUN=true node arbox/one-time-<name>.js
```

Both should exit cleanly and log what they would do.

### 4. Commit and push

```bash
git add arbox/one-time-<name>.js .github/workflows/one-time-<name>.yml
git commit -m "Add one-time enrollment for <date>: <primary> with <fallback> fallback"
git push
```

### 5. Create cron-job.org one-shot jobs

**Do this for each trigger time.** `expiresAt: 1` = fire once and self-delete.

Israel is UTC+3 in summer (IDT). Convert: 20:30 Israel = 17:30 UTC.

```bash
source .env

# Primary slot (e.g. 20:30 Israel = hours:17 minutes:30 UTC, mdays+months pin the exact date)
curl -s -X PUT "https://api.cron-job.org/jobs" \
  -H "Authorization: Bearer $CRONJOB_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "job": {
      "title": "One-Time <Name> <SLOT> Enrollment",
      "enabled": true,
      "saveResponses": true,
      "url": "https://api.github.com/repos/oritlevinhazan/personal-automations/actions/workflows/one-time-<name>.yml/dispatches",
      "requestMethod": 1,
      "extendedData": {
        "headers": {
          "Accept": "application/vnd.github+json",
          "Authorization": "Bearer '"$GITHUB_PERSONAL_ACCESS_TOKEN"'",
          "Content-Type": "application/json"
        },
        "body": "{\"ref\": \"master\", \"inputs\": {\"slot\": \"0830\", \"dry_run\": \"false\"}}"
      },
      "schedule": {
        "timezone": "Asia/Jerusalem",
        "hours": [20], "minutes": [30],
        "mdays": [<day>], "months": [<month>], "wdays": [-1],
        "expiresAt": 1
      }
    }
  }'
```

Note the returned `jobId` for each job — useful if you need to cancel or verify.

### 6. Verify jobs were created

```bash
source .env && curl -s "https://api.cron-job.org/jobs" \
  -H "Authorization: Bearer $CRONJOB_API_KEY" | \
  python3 -c "import sys,json; [print(j['jobId'], j['title'], j.get('enabled')) for j in json.load(sys.stdin)['jobs']]"
```

## Key rules

- **Never use `sleep` in a GitHub Actions job** to wait hours — it will timeout. Always use cron-job.org as the scheduler.
- **Separate Alertzy notification per attempt** — user wants to know the 08:30 result at 20:30, not wait until 21:30.
- **Fallback slot checks primary first** — at 21:30, always re-check the primary slot for a freed-up spot before trying the fallback.
- The weekly `app.js` / `main.yml` are never modified for one-time automations — always create a new standalone script and workflow.
