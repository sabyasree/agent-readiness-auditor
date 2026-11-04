# Agent-readiness audit skill

Makes your coding agent check, fix and verify how well AI agents can use your web pages.

AI agents like Claude in Chrome, Gemini in Chrome and Perplexity Comet don't see your design. They read the accessibility tree, the same structure screen readers use. A clickable `<div>`, an icon button with no name or a form field with only placeholder text stops them. This skill gives your agent a tested loop to find and fix those problems:

1. **Audit** the page with 42 checks: a 0–100 score, every problem element with its CSS selector, and suggested code.
2. **Fix** the source, highest-impact first, following rules that keep the fixes accessible (native HTML first, meaningful names, no hidden workarounds).
3. **Re-audit** until the score reaches the target, typically 90 or more.
4. **Report** the score before and after, and the files changed.

It also scans up to 25 pages to find problems shared across a site, so the agent fixes the shared template once.

**What it checks:** real buttons and links, control names, form labels and input types, keyboard and focus access, overlays and CAPTCHAs, stable selectors, page structure, hidden prompt-injection text, product data for AI shopping agents, and llms.txt and robots.txt rules for AI. 19 checks are also WCAG 2.2 criteria, so accessibility improves as well.

## Works with

Claude Code, Cursor, GitHub Copilot, Claude Desktop, Windsurf, Gemini CLI, Codex CLI and any MCP client. It uses the free `agent-readiness-audit` MCP server, or its CLI in agents without MCP.

## Install

1. Add the skill folder to your agent's skills directory (for Claude Code, `~/.claude/skills/` or `.claude/skills/` in your project).
2. Add the MCP server. For Claude Code:
   ```
   claude mcp add agent-readiness -- npx -y agent-readiness-audit mcp
   ```
   Other agents: see `references/setup.md`.
3. Run `npx playwright install chromium` once.

Then ask your agent something like: *"Make the product page agent-ready"*, *"Audit http://localhost:3000 for AI agents and fix the issues"* or *"Why can't AI agents use our checkout form?"*

## Privacy

The audit runs on your machine. It reads the page and a few files on the same site (`/robots.txt`, `/llms.txt`, `/sitemap.xml`, `/.well-known/`), changes nothing on the site, and sends nothing to anyone else.

## Also available

- **Chrome extension:** audit any page in your own browser, including signed-in pages, and watch an agent try a task on the live page. [Agent-Readiness Auditor on the Chrome Web Store](https://chromewebstore.google.com/detail/agent-readiness-auditor/bgaigjpjdemhkngkaocgfekiedfaigfa?utm_source=agensi&utm_medium=marketplace&utm_campaign=skill)
- **Website:** https://agent-readiness-auditor.netlify.app/?utm_source=agensi&utm_medium=marketplace&utm_campaign=skill

## License

Copyright © 2026 Sabyasachi Mondal. All rights reserved. You may use this skill with your coding agent. You may not copy, modify, redistribute or resell it. See the LICENSE file.
