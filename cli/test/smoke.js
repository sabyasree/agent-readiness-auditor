'use strict';

const BIN = require('path').join(__dirname, '..', 'bin', 'agent-readiness.js');

// Smoke test: serves a small page with known problems, runs the CLI on it,
// then talks to the MCP server over stdio. Needs Playwright's Chromium.

const assert = require('assert');
const http = require('http');
const path = require('path');
const { spawn, execFile } = require('child_process');

// Async on purpose: a sync call would block this process's own test server.
const run = (args) => new Promise((resolve) => {
  execFile(process.execPath, [BIN, ...args], { encoding: 'utf8', maxBuffer: 1 << 26 }, (err, stdout) => resolve({ code: err ? err.code : 0, stdout }));
});

const PAGE = `<!doctype html><html lang="en"><head><title>Smoke test shop</title></head><body>
<main><h1>Trail pack</h1><p>A light pack for long days on the trail.</p>
<button class="icon-cart"><svg width="16" height="16"></svg></button>
<div class="buy" style="cursor:pointer" onclick="1">Add to cart</div>
<input placeholder="Email"></main></body></html>`;


function mcpSession(messages) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, 'mcp'], { stdio: ['pipe', 'pipe', 'inherit'] });
    const replies = [];
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (line.trim()) replies.push(JSON.parse(line));
        if (replies.length === messages.filter((m) => m.id !== undefined).length) child.stdin.end();
      }
    });
    child.on('exit', () => resolve(replies));
    child.on('error', reject);
    for (const m of messages) child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
  });
}

(async () => {
  const server = http.createServer((req, res) => { res.writeHead(req.url === '/' ? 200 : 404, { 'content-type': 'text/html' }); res.end(req.url === '/' ? PAGE : 'Not found'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  try {
    const json = JSON.parse((await run([url, '--json'])).stdout);
    const failing = json.categories.flatMap((c) => c.checks).filter((k) => k.status === 'fail').map((k) => k.id);
    for (const id of ['unnamed-controls', 'fake-controls', 'unlabeled-fields']) assert(failing.includes(id), `CLI should flag ${id}`);
    console.log(`CLI: score ${json.score}, flags ${failing.length} failing checks`);

    const gate = (await run([url, '--summary', '--min-score', '99'])).code;
    assert.strictEqual(gate, 1, '--min-score should exit with 1 below the minimum');
    console.log('CLI: --min-score exits with 1');

    const replies = await mcpSession([
      { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } },
      { method: 'notifications/initialized' },
      { id: 2, method: 'tools/list' },
      { id: 3, method: 'tools/call', params: { name: 'audit_url', arguments: { url } } },
      { id: 4, method: 'tools/call', params: { name: 'audit_url', arguments: { url: 'ftp://nope' } } },
    ]);
    const byId = Object.fromEntries(replies.map((r) => [r.id, r]));
    assert.strictEqual(byId[1].result.serverInfo.name, 'agent-readiness');
    assert.deepStrictEqual(byId[2].result.tools.map((t) => t.name), ['audit_url', 'scan_site']);
    const text = byId[3].result.content[0].text;
    assert(/Agent-readiness: \d+\/100/.test(text) && /suggested: <button/.test(text), 'audit_url should return a report with suggested code');
    assert.strictEqual(byId[4].result.isError, true, 'a bad URL should be a tool error');
    console.log('MCP: initialize, tools/list, audit_url and errors work');
    console.log('All smoke tests passed.');
  } finally {
    server.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
