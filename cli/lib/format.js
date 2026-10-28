'use strict';

// Plain-text reports, for the terminal and for coding agents reading MCP results.

const LABEL = { pass: 'PASS', warn: 'WARN', fail: 'FAIL', info: 'NOTE', na: 'N/A' };

/** One page's report: score, categories, then each failing or warning check with its elements and fixes. */
function reportText(r, { details = true, maxFindings = 8 } = {}) {
  const L = [];
  L.push(`Agent-readiness: ${r.score}/100, ${r.grade}`);
  L.push(`${r.title || 'Untitled'} (${r.url})`);
  L.push(`${r.counts.fail} failing, ${r.counts.warn} warnings, ${r.counts.pass} passed. ${r.gradeText}`);
  L.push('');
  for (const c of r.categories) {
    if (c.scored === false) continue;
    L.push(`  ${c.name.padEnd(28)} ${c.score == null ? 'n/a' : String(c.score).padStart(3)}`);
  }
  const issues = r.categories.flatMap((cat) => cat.checks
    .filter((k) => k.status === 'fail' || k.status === 'warn')
    .map((k) => ({ cat, k })))
    .sort((a, b) => (a.k.status === 'fail' ? 0 : 1) - (b.k.status === 'fail' ? 0 : 1) || (b.k.weight || 0) - (a.k.weight || 0));
  if (!issues.length) {
    L.push('', 'No issues found.');
    return L.join('\n');
  }
  L.push('', `Issues (${issues.length}):`);
  for (const { cat, k } of issues) {
    L.push('', `[${LABEL[k.status]}] ${k.title} (${cat.name}, ${k.id})`);
    L.push(`  ${k.summary}`);
    if (!details) continue;
    L.push(`  Why: ${k.why}`);
    L.push(`  Fix: ${k.fix}`);
    for (const f of k.findings.slice(0, maxFindings)) {
      L.push(`  - ${f.snippet}${f.note ? `  (${f.note})` : ''}`);
      if (f.selector) L.push(`    selector: ${f.selector}`);
      if (f.fix) L.push(`    suggested: ${f.fix.replace(/\n/g, ' ')}`);
    }
    if (k.issues > Math.min(maxFindings, k.findings.length)) L.push(`  …and ${k.issues - Math.min(maxFindings, k.findings.length)} more`);
  }
  return L.join('\n');
}

/** A site scan: average, the problems shared across pages, and each page's score. */
function scanText(s, pathOf) {
  const { summary } = s;
  const L = [];
  L.push(`Agent-readiness site scan: ${s.origin}`);
  L.push(`Average ${summary.avg}/100 across ${summary.done} of ${s.pages.length} pages.`);
  L.push('', 'Problems shared across pages (most widespread first):');
  if (!summary.shared.length) L.push('  None.');
  for (const x of summary.shared) {
    const share = summary.done ? x.pages.length / summary.done : 0;
    L.push(`  ${String(x.pages.length).padStart(2)}/${summary.done}  ${x.title} (${x.cat}, ${x.id})${share >= 0.5 && summary.done > 2 ? '  <- likely a shared template' : ''}`);
  }
  L.push('', 'Pages:');
  for (const p of s.pages) {
    L.push(p.result ? `  ${String(p.result.score).padStart(3)}  ${pathOf(p.url)}` : `    -  ${pathOf(p.url)}  (${p.error})`);
  }
  return L.join('\n');
}

module.exports = { reportText, scanText };
