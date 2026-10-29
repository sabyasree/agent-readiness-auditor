// Agent-Readiness Auditor. Copyright (c) 2026 Sabyasachi Mondal. All rights reserved.
// Use is subject to the LICENSE file; copying, modifying or redistributing this code is not permitted.
'use strict';

// "Mark issues on page": numbered markers on every element with a problem,
// drawn in a closed shadow root so the page's styles can't reach them.
// Both functions are serialized and run inside the page. They must not
// reference anything outside themselves.

function markAllInPage(items, runId, opts) {
  const steps = !!(opts && opts.steps);
  if (window.__ARA_MARKS) window.__ARA_MARKS.stop();
  const store = window.__ARA;
  const byEl = new Map();
  let missing = 0;
  for (const it of items) {
    let el = store && store.runId === runId ? store.refs[it.ref] : null;
    if (!el || !el.isConnected) {
      try { el = it.selector ? document.querySelector(it.selector) : null; } catch (e) { el = null; }
    }
    if (!el || !el.isConnected) { missing++; continue; }
    if (!byEl.has(el)) byEl.set(el, { el, tone: it.tone, labels: [] });
    const m = byEl.get(el);
    if (it.tone === 'fail') m.tone = 'fail';
    if (steps && m.labels.length) { m.labels.push(it.label); continue; }
    if (m.labels.length < 4) m.labels.push(it.label);
  }
  const marks = [...byEl.values()].slice(0, 250);

  const host = document.createElement('div');
  host.setAttribute('data-agent-readiness-highlight', '');
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML =
    '<style>' +
    ':host{all:initial}' +
    '.box{position:fixed;border:2px dashed var(--c);border-radius:4px;background:color-mix(in srgb,var(--c) 7%,transparent)}' +
    '.pin{position:fixed;min-width:20px;height:20px;padding:0 5px;border-radius:10px;background:var(--c);color:#fff;' +
    'font:700 11px/20px system-ui,sans-serif;text-align:center;box-shadow:0 1px 4px rgba(0,0,0,.35);pointer-events:auto;cursor:help}' +
    '.fail{--c:#B3261E}.warn{--c:#9A5A00}.step{--c:#2F4BD0}' +
    '.bar{position:fixed;top:12px;right:12px;display:flex;gap:10px;align-items:center;padding:8px 10px 8px 14px;' +
    'background:#172033;color:#fff;border-radius:10px;font:600 13px/1.3 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.3);pointer-events:auto}' +
    '.bar i{display:inline-block;width:10px;height:10px;border-radius:50%;margin:0 4px 0 8px;vertical-align:-1px}' +
    '.bar button{all:unset;cursor:pointer;background:#fff;color:#172033;padding:4px 10px;border-radius:6px;font-weight:700}' +
    '.bar button:focus-visible{outline:2px solid #8EA2FF;outline-offset:2px}' +
    '</style>';
  const fails = marks.filter((m) => m.tone === 'fail').length;
  const bar = document.createElement('div');
  bar.className = 'bar';
  // Labels come translated from the panel (opts.text); English otherwise.
  const L = Object.assign({
    test: 'Agent test: $1', step: '1 step', steps: '$1 steps', marked: 'Agent-Readiness: $1 marked',
    element: '1 element', elements: '$1 elements', failing: 'failing', warning: 'warning', hide: 'Hide',
  }, opts && opts.text);
  const label = document.createElement('span');
  const count = steps ? (items.length === 1 ? L.step : L.steps.replace('$1', items.length))
    : (marks.length === 1 ? L.element : L.elements.replace('$1', marks.length));
  const [pre, post] = (steps ? L.test : L.marked).split('$1');
  const b = document.createElement('b');
  b.textContent = count;
  label.append(pre || '', b, post || '');
  if (!steps) {
    for (const [color, text] of [['#B3261E', L.failing], ['#9A5A00', L.warning]]) {
      const dot = document.createElement('i');
      dot.style.background = color;
      label.append(dot, text);
    }
  }
  const hide = document.createElement('button');
  hide.type = 'button';
  hide.textContent = L.hide;
  bar.append(label, hide);
  root.appendChild(bar);

  const nodes = marks.map((m, i) => {
    const box = document.createElement('div');
    box.className = 'box ' + m.tone;
    const pin = document.createElement('div');
    pin.className = 'pin ' + m.tone;
    pin.textContent = steps ? m.labels.map((l) => l.match(/^\d+/)?.[0] || '').filter(Boolean).join(',') || String(i + 1) : String(i + 1);
    pin.title = m.labels.join('\n');
    root.append(box, pin);
    return { m, box, pin };
  });

  let raf = 0;
  const place = () => {
    raf = 0;
    const vw = window.innerWidth;
    for (const { m, box, pin } of nodes) {
      // Hidden or off-screen elements (like hidden instructions) are shown on their nearest visible container.
      let t = m.el.isConnected ? m.el : null;
      let r = t ? t.getBoundingClientRect() : null;
      while (t && t.parentElement && t.parentElement !== document.body && (r.right <= 0 || r.left >= vw || (r.width === 0 && r.height === 0))) {
        t = t.parentElement;
        r = t.getBoundingClientRect();
      }
      const page = !t || t === document.documentElement || t === document.body || t === document.head;
      const hide = page || !r || (r.width === 0 && r.height === 0) || r.bottom < -40 || r.top > window.innerHeight + 40;
      box.style.display = pin.style.display = hide ? 'none' : '';
      if (hide) continue;
      if (t !== m.el) box.style.display = 'none'; // only a number for content that has no box of its own
      box.style.left = (r.left - 3) + 'px';
      box.style.top = (r.top - 3) + 'px';
      box.style.width = (r.width + 6) + 'px';
      box.style.height = (r.height + 6) + 'px';
      pin.style.left = Math.min(Math.max(2, r.left - 10), vw - 30) + 'px';
      pin.style.top = Math.max(2, r.top - 12) + 'px';
    }
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(place); };
  window.addEventListener('scroll', schedule, { capture: true, passive: true });
  window.addEventListener('resize', schedule, { passive: true });
  const timer = setInterval(schedule, 800);
  document.documentElement.appendChild(host);
  place();

  const stop = () => {
    cancelAnimationFrame(raf);
    clearInterval(timer);
    window.removeEventListener('scroll', schedule, { capture: true });
    window.removeEventListener('resize', schedule);
    host.remove();
    if (window.__ARA_MARKS && window.__ARA_MARKS.host === host) window.__ARA_MARKS = null;
  };
  bar.querySelector('button').addEventListener('click', stop);
  window.__ARA_MARKS = { host, stop };
  return { ok: true, shown: marks.length, missing, fails };
}

function clearMarksInPage() {
  if (window.__ARA_MARKS) window.__ARA_MARKS.stop();
  return { ok: true };
}

/** Whether the markers are still showing (the person may have pressed Hide on the page). */
function marksShownInPage() {
  return !!window.__ARA_MARKS;
}
