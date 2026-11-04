// Agent-Readiness Auditor. Copyright (c) 2026 Sabyasachi Mondal. All rights reserved.
// Use is subject to the LICENSE file; copying, modifying or redistributing this code is not permitted.
'use strict';

// Writes skills/agent-readiness-audit/references/checks.md from the checks in
// content/auditor.js, so the skill always describes the real checks.
// Run: node scripts/build-skill-checks.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'content/auditor.js'), 'utf8');
const unq = (s) => s.replace(/\\'/g, "'").replace(/\\\\/g, '\\');

const cats = Object.fromEntries([...src.matchAll(/\{ id: '([a-z]+)', name: '([^']+)', weight: (\d+)(?:, scored: (false))?/g)]
  .map((m) => [m[1], { name: m[2], scored: m[4] !== 'false' }]));
const sc = Object.fromEntries([...src.matchAll(/'(\d\.\d\.\d+)': \['([^']+)', '(A+)'/g)].map((m) => [m[1], `${m[1]} ${m[2]} (${m[3]})`]));
const byCheck = {};
const map = src.slice(src.indexOf('const WCAG_BY_CHECK = {'), src.indexOf('const wcagFor'));
for (const m of map.matchAll(/'([a-z-]+)': \[([^\]]+)\]/g)) byCheck[m[1]] = [...m[2].matchAll(/'([\d.]+)'/g)].map((x) => sc[x[1]]);
const re = /id: '([a-z-]+)', category: '([a-z]+)', weight: (\d)[^\n]*\n\s+title: '((?:[^'\\]|\\.)*)',\n\s+why: '((?:[^'\\]|\\.)*)',\n\s+fix: '((?:[^'\\]|\\.)*)'/g;
const checks = [...src.matchAll(re)].map((m) => ({ id: m[1], cat: m[2], weight: +m[3], title: unq(m[4]), why: unq(m[5]), fix: unq(m[6]) }));

let out = `# Agent-readiness checks: what each one means and how to fix it

The audit runs ${checks.length} checks in ten categories. Each check scores 0–100; 95+ passes, 70–94 is a warning, below 70 fails. In reports and JSON, use the **check id** to find the entry here.

Fix in this order: failing checks with a high weight first (weight 3 counts three times as much as weight 1). Checks under "Agent protocols" are information only and never affect the score.

`;
for (const [id, c] of Object.entries(cats)) {
  const list = checks.filter((k) => k.cat === id);
  if (!list.length) continue;
  out += `## ${c.name}${c.scored ? '' : ' (information only, not scored)'}\n\n`;
  for (const k of list) {
    out += `### \`${k.id}\`: ${k.title}\n\n- **Why:** ${k.why}\n- **Fix:** ${k.fix}\n`;
    if (k.weight) out += `- **Weight:** ${k.weight}\n`;
    if (byCheck[k.id]) out += `- **Also WCAG 2.2:** ${byCheck[k.id].join(', ')}\n`;
    out += '\n';
  }
}
fs.writeFileSync(path.join(ROOT, 'skills/agent-readiness-audit/references/checks.md'), out);
console.log(`${checks.length} checks written`);
