#!/usr/bin/env node
'use strict';

const { launch, auditUrl, scanSite, pathOf } = require('../lib/audit');
const { reportText, scanText } = require('../lib/format');
const { version } = require('../package.json');

const HELP = `agent-readiness-audit ${version}
Audit how well AI agents can read and use a web page.

Usage
  agent-readiness-audit <url> [options]     Audit one page
  agent-readiness-audit <url> --pages 10    Audit up to 25 pages of the site
  agent-readiness-audit mcp                 Run as an MCP server (stdio) for coding agents

Options
  --json              Print the full report as JSON
  --min-score <n>     Exit with code 1 if the score (or site average) is below n. For CI.
  --pages <n>         Scan n pages of the site (1-25) instead of one page
  --summary           Leave out the per-element details
  -h, --help          Show this help
  -v, --version       Show the version

Examples
  npx agent-readiness-audit https://example.com
  npx agent-readiness-audit http://localhost:3000 --min-score 80
  npx agent-readiness-audit https://shop.example --pages 10 --json > scan.json
  claude mcp add agent-readiness -- npx -y agent-readiness-audit mcp

First run: npx playwright install chromium`;

function parseArgs(argv) {
  const out = { json: false, summary: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--summary') out.summary = true;
    else if (a === '--min-score') out.minScore = Number(argv[++i]);
    else if (a === '--pages') out.pages = Number(argv[++i]);
    else if (a === '-h' || a === '--help') out.help = true;
    else if (a === '-v' || a === '--version') out.version = true;
    else if (!out.target) out.target = a;
    else throw new Error(`Unexpected argument: ${a}`);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.version) return console.log(version);
  if (args.help || !args.target) return console.log(HELP);
  if (args.target === 'mcp') return require('../lib/mcp').startMcpServer();

  let url = args.target;
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  const browser = await launch();
  let score;
  try {
    if (args.pages) {
      const result = await scanSite(browser, url, args.pages, (p, i, n) => {
        if (!args.json) process.stderr.write(`  ${i}/${n} ${p.result ? String(p.result.score).padStart(3) : '  -'}  ${pathOf(p.url)}\n`);
      });
      score = result.summary.avg;
      console.log(args.json ? JSON.stringify(result, null, 2) : `\n${scanText(result, pathOf)}`);
    } else {
      const report = await auditUrl(browser, url);
      score = report.score;
      console.log(args.json ? JSON.stringify(report, null, 2) : reportText(report, { details: !args.summary }));
    }
  } finally {
    await browser.close();
  }
  if (Number.isFinite(args.minScore) && score < args.minScore) {
    console.error(`\nScore ${score} is below the minimum of ${args.minScore}.`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`agent-readiness-audit: ${(e && e.message) || e}`);
  process.exitCode = 2;
});
