# Auto-Enroll Arbox — Claude Setup

## Session start checklist

At the start of every session, check that these two files exist. If either is missing, tell the user and help them recreate it.

### `.env` (required)

```
ARBOX_USER_EMAIL=...
ARBOX_USER_PASSWORD=...
ALERTZY_ACCOUNT_KEY=...
GITHUB_PERSONAL_ACCESS_TOKEN=...
CRONJOB_API_KEY=...
```

- `ARBOX_USER_EMAIL` / `ARBOX_USER_PASSWORD` — Arbox login credentials
- `ALERTZY_ACCOUNT_KEY` — from the Alertzy app (push notifications)
- `GITHUB_PERSONAL_ACCESS_TOKEN` — GitHub PAT with `repo` and `workflow` scopes for `oritlevinhazan/personal-automations`
- `CRONJOB_API_KEY` — from cron-job.org account settings

### `.mcp.json` (required for GitHub MCP tools)

```json
{
  "mcpServers": {
    "github": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "paste your token here"
      }
    }
  }
}
```

Note: `mcpServers` goes in `.mcp.json` at the repo root, NOT in `.claude/settings.json`.

Both files are gitignored — they must be recreated manually on each new machine.
