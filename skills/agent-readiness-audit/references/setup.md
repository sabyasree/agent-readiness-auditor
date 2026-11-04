# Setting up the agent-readiness-audit MCP server

The server runs locally over stdio with `npx -y agent-readiness-audit mcp`. It needs Node.js 18 or newer, and a headless Chromium the first time:

```
npx playwright install chromium
```

Pick your agent below. Restart the agent after changing its configuration. File locations change between versions, so check your client's MCP documentation if a path doesn't exist.

## Claude Code

```
claude mcp add agent-readiness -- npx -y agent-readiness-audit mcp
```

## Cursor

`.cursor/mcp.json` in the project, or `~/.cursor/mcp.json` for all projects:

```json
{
  "mcpServers": {
    "agent-readiness": { "command": "npx", "args": ["-y", "agent-readiness-audit", "mcp"] }
  }
}
```

## GitHub Copilot in VS Code

`.vscode/mcp.json` in the project:

```json
{
  "servers": {
    "agent-readiness": { "type": "stdio", "command": "npx", "args": ["-y", "agent-readiness-audit", "mcp"] }
  }
}
```

## Claude Desktop

`claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "agent-readiness": { "command": "npx", "args": ["-y", "agent-readiness-audit", "mcp"] }
  }
}
```

## Windsurf

`~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "agent-readiness": { "command": "npx", "args": ["-y", "agent-readiness-audit", "mcp"] }
  }
}
```

## Gemini CLI

`~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "agent-readiness": { "command": "npx", "args": ["-y", "agent-readiness-audit", "mcp"] }
  }
}
```

## Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.agent-readiness]
command = "npx"
args = ["-y", "agent-readiness-audit", "mcp"]
```

## Any other MCP client

Use command `npx` with arguments `-y agent-readiness-audit mcp`, transport stdio.

## Without MCP

Every agent with a terminal can use the CLI, which prints the same report:

```
npx -y agent-readiness-audit http://localhost:3000            # one page
npx -y agent-readiness-audit http://localhost:3000 --json     # full JSON report
npx -y agent-readiness-audit https://example.com --pages 10   # site scan
npx -y agent-readiness-audit http://localhost:3000 --min-score 80   # exit 1 below 80
```

## Troubleshooting

- **"Chromium isn't installed for Playwright":** run `npx playwright install chromium` (on Linux CI, add `--with-deps`).
- **The audit can't reach the page:** start the dev server first and use the exact URL it prints. Pages behind a login can't be audited by the tool.
- **The tool isn't listed:** check that `npx -y agent-readiness-audit --version` works in a terminal, then restart the agent.
