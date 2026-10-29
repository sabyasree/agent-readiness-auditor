// Agent-Readiness Auditor. Copyright (c) 2026 Sabyasachi Mondal. All rights reserved.
// Use is subject to the LICENSE file; copying, modifying or redistributing this code is not permitted.
'use strict';

// "Run the steps": carry out the Agent test's plan on a fresh copy of the page
// in a background tab, the way an agent would. Each step finds its control by
// role and name in the accessibility tree, clicks, types or chooses, and
// records what happened. It runs with the person's own login on the site, so
// it stops before anything that could spend money, delete data or send
// personal details.

const RUN_SETTLE_MS = 1200;

// Clicks the run never makes: buying, paying, deleting, cancelling.
const RISKY_CLICK = /\b(place|submit|confirm|complete|finish)\b.{0,12}\b(order|purchase|payment|booking)\b|\bpay\b|\bbuy now\b|\bpurchase\b|\bcheck ?out\b|\bdelete\b|\bremove (my )?account\b|\bclose (my )?account\b|\bunsubscribe\b|\bcancel\b.{0,12}\b(subscription|account|order|membership)\b|\bdonate\b|\btransfer\b|\bsend money\b/i;
// Fields the run never types into.
const PERSONAL_FIELD = /e-?mail|password|passcode|\bpin\b|phone|\btel\b|mobile|card|cvv|cvc|expir|iban|account (number|no)|address|post ?code|zip|birth|ssn|social security|passport/i;

/** Which of the page's controls with this role and name the target is (0 for the first). */
function targetOccurrence(r, target) {
  return testTargets(r).filter((x) => x.role === target.role && x.name === target.name).findIndex((x) => x.ref === target.ref);
}

/** Why a step is not run, or '' if it's safe to try. */
function stepRisk(step) {
  const name = (step.target && step.target.name) || '';
  if (step.action === 'click' && RISKY_CLICK.test(name)) return 'risky';
  if ((step.action === 'type' || step.action === 'select') && PERSONAL_FIELD.test(name)) return 'personal';
  return '';
}

// ---------------------------------------------------------------- in the page

/** In the background tab: find the control by role and name. Returns its ref, or -1. */
async function runFindInPage(role, name, nth) {
  if (!window.__ARA) return -2;
  const { agentView } = await window.__ARA.run({ viewOnly: true });
  const hits = agentView.nodes.filter((n) => n.role === role && n.name === name);
  const hit = hits[Math.max(0, nth)] || hits[0];
  return hit ? hit.ref : -1;
}

/** In the background tab: do one step on the element with this ref and report what changed. */
async function runActInPage(ref, action, text, settleMs) {
  const el = window.__ARA && window.__ARA.refs[ref];
  if (!el || !el.isConnected) return { error: 'gone' };
  const type = (el.getAttribute('type') || '').toLowerCase();
  const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
  if ((action === 'type' || action === 'select') && (/^(email|password|tel)$/.test(type) || /^(cc-|email|tel|current-password|new-password|street|postal|address|bday)/.test(ac))) {
    return { blocked: 'personal' };
  }
  let mutations = 0;
  const mo = new MutationObserver((list) => { mutations += list.length; });
  mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  const dialogsBefore = document.querySelectorAll('dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]').length;
  el.scrollIntoView({ block: 'center' });
  if (action === 'type') {
    el.focus();
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value');
    if (text) {
      if (setter && setter.set) setter.set.call(el, text); else el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    // Search fields: submit the search, as an agent pressing Enter would.
    if (text && (type === 'search' || el.getAttribute('role') === 'searchbox')) {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
      if (el.form && typeof el.form.requestSubmit === 'function') el.form.requestSubmit();
    }
  } else if (action === 'select' && el instanceof HTMLSelectElement) {
    const want = String(text || '').toLowerCase();
    const opt = [...el.options].find((o) => o.text.trim().toLowerCase() === want) || [...el.options].find((o) => want && o.text.toLowerCase().includes(want));
    if (!opt) { mo.disconnect(); return { error: 'option' }; }
    el.value = opt.value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    el.click();
  }
  await new Promise((r) => setTimeout(r, settleMs));
  mo.disconnect();
  const dialogsAfter = document.querySelectorAll('dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]').length;
  return { mutations, dialog: dialogsAfter > dialogsBefore, url: location.href, typed: action === 'type' && !!text };
}

// ---------------------------------------------------------------- in the panel

/**
 * Run the plan's steps on the live page. Calls onStep(outcomes) as it goes.
 * Each outcome is { kind, detail }: done, navigated, nochange, typed, focused,
 * notfound, risky, personal, error.
 */
async function runPlanLive(r, steps, { onStep, isCancelled }) {
  const outcomes = [];
  const push = (o) => { outcomes.push(o); onStep(outcomes.slice()); };
  const tab = await chrome.tabs.create({ url: r.url, active: false });
  let finalUrl = r.url;
  const inject = () => chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/auditor.js'] });
  const call = async (func, args) => (await chrome.scripting.executeScript({ target: { tabId: tab.id }, func, args }))[0].result;
  const settled = async () => {
    const now = await chrome.tabs.get(tab.id);
    if (now.status === 'loading') { await waitForLoad(tab.id); await sleep(500); }
  };
  try {
    await waitForLoad(tab.id);
    await sleep(SCAN_SETTLE_MS);
    for (const step of steps) {
      if (isCancelled()) break;
      if (!step.target) { push({ kind: 'notfound' }); break; }
      const risk = stepRisk(step);
      if (risk) { push({ kind: risk }); break; }
      await inject();
      let ref = await call(runFindInPage, [step.target.role, step.target.name, targetOccurrence(r, step.target)]);
      if (ref === -2) { await inject(); ref = await call(runFindInPage, [step.target.role, step.target.name, targetOccurrence(r, step.target)]); }
      if (ref < 0) { push({ kind: 'notfound' }); break; }
      const before = (await chrome.tabs.get(tab.id)).url;
      let res;
      try {
        res = await call(runActInPage, [ref, step.action, step.text || '', RUN_SETTLE_MS]);
      } catch {
        res = { navigated: true }; // the page unloaded while the step ran
      }
      await settled();
      const after = (await chrome.tabs.get(tab.id)).url;
      finalUrl = after;
      // A step that loads another page returns no result: the page unloaded mid-step.
      if (after !== before || (res && res.navigated)) { push({ kind: 'navigated', detail: after }); continue; }
      if (!res) { push({ kind: 'error' }); break; }
      if (res.blocked) { push({ kind: 'personal' }); break; }
      if (res.error) { push({ kind: res.error === 'gone' ? 'notfound' : 'error' }); break; }
      if (res.navigated) push({ kind: 'navigated', detail: after });
      else if (step.action === 'type') push({ kind: res.typed ? 'typed' : 'focused' });
      else if (res.dialog || res.mutations > 0) push({ kind: 'done', dialog: res.dialog });
      else push({ kind: 'nochange' });
    }
    try { finalUrl = (await chrome.tabs.get(tab.id)).url || finalUrl; } catch { /* closed */ }
  } finally {
    try { await chrome.tabs.remove(tab.id); } catch { /* already closed */ }
  }
  return { outcomes, finalUrl, ran: outcomes.length, total: steps.length };
}

const RUN_TEXT = {
  done: 'Done. The page responded.',
  dialog: 'Done. A dialog opened.',
  navigated: 'Done. It went to $1.',
  nochange: 'Done, but nothing visible happened. An agent would wonder if it worked.',
  typed: 'Typed it in.',
  focused: 'Found the field. The plan had nothing to type.',
  notfound: 'Couldn’t find this control on the live page.',
  risky: 'Stopped here. The test never pays, places orders, deletes or cancels anything.',
  personal: 'Stopped here. The test never types personal details such as an email, password or card number.',
  error: 'Couldn’t do this step.',
};
const RUN_TONE = { done: 'pass', navigated: 'pass', typed: 'pass', focused: 'pass', nochange: 'warn', notfound: 'fail', error: 'fail', risky: 'info', personal: 'info' };

/** The "Try it on the live page" box under a test result. */
function liveRunSection(r, res) {
  const steps = res.steps;
  if (!steps.some((s) => s.target) || !/^https?:/.test(r.url)) return null;
  const box = h('div', { class: 'live-run' });
  const state0 = res.live || null;
  let cancelled = false;

  const outcomeList = (outcomes) => h('ol', { class: 'test-steps live-steps' }, steps.map((s, i) => {
    const o = outcomes[i];
    if (!o) return h('li', { class: 'live-pending' }, h('span', { class: 'step-text', text: `${i + 1}. ${describeTarget(s.target)}` }));
    const key = o.kind === 'done' && o.dialog ? 'dialog' : o.kind;
    let where = '';
    try { where = o.detail ? new URL(o.detail).pathname : ''; } catch { where = o.detail || ''; }
    return h('li', { class: `live-${RUN_TONE[o.kind]}` },
      glyph(RUN_TONE[o.kind]),
      h('span', { class: 'step-text' }, h('b', { text: `${i + 1}. ${describeTarget(s.target)}` }), h('span', { class: 'step-note', text: t(RUN_TEXT[key], where) })));
  }));

  const summary = (live) => {
    const ok = live.outcomes.filter((o) => RUN_TONE[o.kind] === 'pass' || RUN_TONE[o.kind] === 'warn').length;
    const last = live.outcomes[live.outcomes.length - 1];
    if (last && (last.kind === 'risky' || last.kind === 'personal')) return t('The agent got through $1 of $2 steps, then stopped for safety.', ok, live.total);
    if (ok === live.total) return tn(live.total, 'The agent got through the step on the live page.', 'The agent got through all $1 steps on the live page.');
    return t('The agent got stuck at step $1 of $2 on the live page.', ok + 1, live.total);
  };

  function draw(live, running) {
    box.replaceChildren(...[
      h('h3', { text: t('Try it on the live page') }),
      !live && !running ? [
        h('p', { class: 'test-note', text: t('Opens this page in a background tab and does each step: clicks, typing and choices, using your login on this site. It stops before anything that could pay, place an order, delete or send personal details. The tab closes when it’s done.') }),
        h('button', { class: 'btn btn-primary btn-small', type: 'button', onclick: start }, t('Run the steps')),
      ] : null,
      running ? h('div', { class: 'live-running' }, h('span', { class: 'scan-spin', 'aria-hidden': 'true' }), h('span', { text: t('Running the steps in a background tab…') }),
        h('button', { class: 'btn btn-quiet btn-small', type: 'button', onclick: () => { cancelled = true; } }, t('Stop'))) : null,
      live ? [
        !running ? h('p', { class: 'live-summary', text: summary(live) }) : null,
        outcomeList(live.outcomes),
        !running ? h('div', { class: 'test-actions' },
          live.finalUrl && live.finalUrl !== r.url ? h('button', { class: 'btn btn-quiet btn-small', type: 'button', onclick: () => chrome.tabs.create({ url: live.finalUrl }) }, t('Open the page it ended on')) : null,
          h('button', { class: 'btn btn-quiet btn-small', type: 'button', onclick: start }, t('Run the steps again'))) : null,
      ] : null,
    ].flat().filter(Boolean));
  }

  async function start() {
    const origin = new URL(r.url).origin;
    let granted = false;
    try { granted = await chrome.permissions.request({ origins: [`${origin}/*`] }); } catch { granted = false; }
    if (!granted) return toast(t('The test needs access to $1 to open the page.', new URL(r.url).host));
    cancelled = false;
    let live = { outcomes: [], total: steps.length };
    draw(live, true);
    try {
      live = await runPlanLive(r, steps, {
        onStep: (outcomes) => { live = { ...live, outcomes }; draw(live, true); },
        isCancelled: () => cancelled,
      });
    } catch (e) {
      live = { ...live, outcomes: [...live.outcomes, { kind: 'error' }] };
    }
    res.live = live;
    draw(live, false);
  }

  draw(state0, false);
  return box;
}
