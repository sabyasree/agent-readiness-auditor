'use strict';

// Projects how the overall score would change if some checks passed, using
// the same weighting as the audit engine (content/auditor.js, run()).

const isIssue = (c) => c.status === 'fail' || c.status === 'warn';

/** Overall score if the checks in `fixedIds` scored 100. */
function scoreWith(r, fixedIds) {
  const fixed = new Set(fixedIds);
  let sum = 0;
  let weights = 0;
  for (const cat of r.categories) {
    if (cat.scored === false) continue;
    const scored = cat.checks.filter((c) => c.score != null && c.weight > 0 && ['pass', 'warn', 'fail'].includes(c.status));
    const wsum = scored.reduce((a, c) => a + c.weight, 0);
    if (!wsum) continue;
    const catScore = Math.round(scored.reduce((a, c) => a + (fixed.has(c.id) ? 100 : c.score) * c.weight, 0) / wsum);
    sum += catScore * cat.weight;
    weights += cat.weight;
  }
  return weights ? Math.round(sum / weights) : 0;
}

/**
 * The fixes worth the most points, biggest first. Each item is
 * { check, category, gain }, where gain is the score increase from that fix alone.
 */
function topFixes(r, n = 3) {
  const base = scoreWith(r, []);
  const out = [];
  for (const cat of r.categories) {
    if (cat.scored === false) continue;
    for (const c of cat.checks) {
      if (!isIssue(c) || c.score == null || !c.weight) continue;
      const gain = scoreWith(r, [c.id]) - base;
      if (gain > 0) out.push({ check: c, category: cat, gain });
    }
  }
  out.sort((a, b) => b.gain - a.gain || (a.check.status === 'fail' ? -1 : 1));
  return out.slice(0, n);
}
