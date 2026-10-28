# agent-readiness

Audit how well AI agents can read and use a web page, from the command line, in CI, or as an MCP server for coding agents. It runs the same checks as the [Agent-Readiness Auditor Chrome extension](https://chromewebstore.google.com/detail/agent-readiness-auditor/bgaigjpjdemhkngkaocgfekiedfaigfa) in a headless browser.

## Install

```
npm install -g agent-readiness
npx playwright install chromium
```

Or run it without installing: `npx agent-readiness <url>`.

## Use

```
agent-readiness https://example.com              # one page: score, categories, issues, suggested code
agent-readiness https://example.com --summary    # without the per-element details
agent-readiness https://example.com --json       # the full report as JSON
agent-readiness https://shop.example --pages 10  # 10 pages of the site and the problems they share
agent-readiness http://localhost:3000 --min-score 80   # exit code 1 below 80, for CI
```

Exit codes: `0` success, `1` score below `--min-score`, `2` the audit couldn't run.

## In CI (GitHub Actions)

```yaml
name: Agent readiness
on: [pull_request]
jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci && npm run build && (npm start &) && npx wait-on http://localhost:3000
      - run: npx -y agent-readiness http://localhost:3000 --min-score 80
        env:
          PLAYWRIGHT_BROWSERS_PATH: 0
      # first time on a runner: npx playwright install --with-deps chromium
```

## As an MCP server

Coding agents can audit pages themselves, fix what's reported, and audit again until the score is good.

**Claude Code**

```
claude mcp add agent-readiness -- npx -y agent-readiness mcp
```

**Cursor, Claude Desktop and other MCP clients** (`mcp.json` or `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "agent-readiness": { "command": "npx", "args": ["-y", "agent-readiness", "mcp"] }
  }
}
```

Tools:

- `audit_url { url, format? }`: score, category scores, and every failing or warning check with why it matters, how to fix it, the affected elements and their CSS selectors, and suggested code. `format: "json"` returns the full report.
- `scan_site { url, pages? }`: up to 25 pages, the average score, and the problems shared across pages (likely in a shared template).

Try asking your agent: *"Use audit_url on http://localhost:3000/product/1, fix the failing checks in our components, and repeat until the score is above 90."*

## Notes

- Pages are loaded in headless Chromium with the page's own content-security policy bypassed so the engine can run. Nothing is sent anywhere except the requests the page itself makes, plus `/llms.txt`, `/robots.txt`, `/sitemap.xml` and a few `/.well-known/` files on the same site.
- Results can differ slightly from the extension, which audits the page in your own browser with your cookies and window size.
- Developing in the extension's repository: `npm test` copies the engine from `../content/auditor.js` and runs a smoke test; `npm pack` copies it into `engine/` for publishing.
