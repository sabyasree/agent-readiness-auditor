// Agent-Readiness Auditor. Copyright (c) 2026 Sabyasachi Mondal. All rights reserved.
// Use is subject to the LICENSE file; copying, modifying or redistributing this code is not permitted.
'use strict';

// A Model Context Protocol server over stdio (newline-delimited JSON-RPC 2.0),
// so coding agents such as Claude Code or Cursor can audit pages themselves:
// fix, re-audit, repeat. Tools: audit_url and scan_site.

const readline = require('readline');
const { launch, auditUrl, scanSite, pathOf } = require('./audit');
const { reportText, scanText } = require('./format');
const { version } = require('../package.json');

const TOOLS = [
  {
    name: 'audit_url',
    description: 'Audit one web page for how well AI agents can read and operate it. Returns a 0-100 score, category scores, and every failing or warning check with why it matters, how to fix it, the affected elements (with CSS selectors) and suggested code. Use it after changing a page to confirm the fix.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The page to audit, such as http://localhost:3000/products/1' },
        format: { type: 'string', enum: ['text', 'json'], description: 'text (default) is a readable report; json is the full report object.' },
      },
      required: ['url'],
    },
  },
  {
    name: 'scan_site',
    description: 'Audit several pages of a site (from its sitemap, or links on the start page) and list the problems shared across pages, which usually live in a shared template or component. Returns the average score, the shared problems and each page’s score.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'A page on the site to start from, usually the home page.' },
        pages: { type: 'integer', minimum: 1, maximum: 25, description: 'How many pages to audit (default 10, at most 25).' },
      },
      required: ['url'],
    },
  },
];

function startMcpServer() {
  let browserPromise = null;
  const browser = () => (browserPromise = browserPromise || launch());
  const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
  const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

  async function callTool(name, args = {}) {
    const url = String(args.url || '');
    if (!/^https?:\/\//i.test(url)) throw new Error('url must start with http:// or https://');
    if (name === 'audit_url') {
      const report = await auditUrl(await browser(), url);
      return args.format === 'json' ? JSON.stringify(report) : reportText(report);
    }
    if (name === 'scan_site') {
      const result = await scanSite(await browser(), url, Number(args.pages) || 10);
      return scanText(result, pathOf);
    }
    throw new Error(`Unknown tool: ${name}`);
  }

  async function handle(msg) {
    const { id, method, params } = msg;
    if (method === 'initialize') {
      return reply(id, {
        protocolVersion: (params && params.protocolVersion) || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'agent-readiness', version },
        instructions: 'Use audit_url to check a page for AI-agent readiness, then fix the reported elements and run audit_url again until the score is good. Use scan_site to find problems shared across a site.',
      });
    }
    if (method === 'ping') return reply(id, {});
    if (method === 'tools/list') return reply(id, { tools: TOOLS });
    if (method === 'tools/call') {
      try {
        const text = await callTool(params && params.name, params && params.arguments);
        return reply(id, { content: [{ type: 'text', text }] });
      } catch (e) {
        return reply(id, { content: [{ type: 'text', text: `Audit failed: ${(e && e.message) || e}` }], isError: true });
      }
    }
    if (id !== undefined && id !== null) return fail(id, -32601, `Method not found: ${method}`);
    return undefined; // notifications such as notifications/initialized need no reply
  }

  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return fail(null, -32700, 'Parse error'); }
    handle(msg).catch((e) => fail(msg.id ?? null, -32603, String((e && e.message) || e)));
  });
  rl.on('close', async () => {
    if (browserPromise) { try { await (await browserPromise).close(); } catch { /* already closed */ } }
    process.exit(0);
  });
}

module.exports = { startMcpServer, TOOLS };
