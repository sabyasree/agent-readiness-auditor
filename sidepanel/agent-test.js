'use strict';

// Agent test: the person describes a task, and a model reads the page the way
// agents do (only the named, interactive elements of the accessibility tree)
// and plans the clicks. Nothing is clicked. The plan is then checked against
// what people can see but agents can't, such as a div posing as "Add to cart".
//
// The model is Gemini Nano through Chrome's built-in Prompt API, running on
// the person's device. Where it isn't available, simple name matching stands in.

const AT_MAX_TARGETS = 120;
const AT_FIELD_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider', 'listbox']);
const AT_STOP = new Set(('a an the to of for on in and or my me i this that it is be with at by from your page please then ' +
  'can could would should will do does how what where which want need go get some any').split(' '));
const AT_SYNONYMS = [
  ['cart', 'bag', 'basket', 'trolley'],
  ['buy', 'purchase', 'checkout', 'order'],
  ['login', 'log', 'signin', 'sign'],
  ['signup', 'register', 'join', 'subscribe', 'newsletter'],
  ['search', 'find', 'look'],
  ['contact', 'support', 'help'],
  ['price', 'cost'],
];
const AT_LANG = [{ type: 'text', languages: ['en'] }];

const AT_SYSTEM = 'You are a web agent operating a page for a user. You cannot see the screen. ' +
  'You only know the numbered elements listed, which are the controls in the page’s accessibility tree. ' +
  'Plan the shortest sequence of actions that completes the task, using only element numbers from the list. ' +
  'Use "type" for text fields and "click" for everything else. ' +
  'If a needed control is not in the list, set possible to false and say in missing what you looked for. Do not invent elements.';

const AT_SCHEMA = {
  type: 'object',
  properties: {
    possible: { type: 'boolean' },
    steps: {
      type: 'array',
      maxItems: 6,
      items: {
        type: 'object',
        properties: {
          element: { type: 'integer' },
          action: { type: 'string', enum: ['click', 'type', 'select'] },
          text: { type: 'string' },
        },
        required: ['element', 'action'],
      },
    },
    missing: { type: 'string' },
  },
  required: ['possible', 'steps'],
};

function atWords(t) {
  return (String(t || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((w) => w.length > 1 && !AT_STOP.has(w));
}

/** Task words plus their synonyms. */
function atExpand(words) {
  const out = new Set(words);
  for (const w of words) {
    for (const group of AT_SYNONYMS) if (group.includes(w)) group.forEach((g) => out.add(g));
  }
  return out;
}

function atOverlap(taskSet, text) {
  return atWords(text).filter((w) => taskSet.has(w)).length;
}

/** The interactive elements an agent can see, numbered from 1, with the heading each sits under. */
function testTargets(r) {
  const v = r.agentView;
  if (!v) return [];
  const out = [];
  let heading = '';
  for (const n of v.nodes) {
    if (n.role === 'heading') heading = n.name;
    if (!INTERACTIVE_ROLES.has(n.role)) continue;
    out.push({ i: out.length + 1, role: n.role, name: n.name, props: n.props, ref: n.ref, under: heading, unnamed: n.flag === 'unnamed' });
  }
  return out;
}

/** Elements people can click but agents don't see as controls, from the audit's findings. */
function hiddenControls(r) {
  const out = [];
  for (const cat of r.categories) {
    for (const c of cat.checks) {
      if (c.id !== 'fake-controls' && c.id !== 'cart-button') continue;
      for (const f of c.findings) {
        const text = String(f.snippet || '').replace(/<[^>]*>?/g, ' ').replace(/\s+/g, ' ').trim();
        // The same element can be flagged by more than one check.
        if (text && !out.some((o) => o.selector === f.selector && o.text === text)) out.push({ text, ref: f.ref, selector: f.selector, checkId: c.id });
      }
    }
  }
  return out;
}

/** Up to three task ideas that fit this page. */
function testSuggestions(r) {
  const targets = testTargets(r);
  const names = targets.map((t) => t.name.toLowerCase()).join(' | ');
  const commerce = r.categories.find((c) => c.id === 'commerce');
  const out = [];
  if (commerce && commerce.score != null) out.push('Add this product to the cart');
  if (/search/.test(names) || targets.some((t) => t.role === 'searchbox')) out.push('Search the site for “gift card”');
  if (/sign in|log in|login/.test(names)) out.push('Sign in to my account');
  if (/subscribe|newsletter|sign up/.test(names) || hiddenControls(r).some((h) => /subscribe|sign up/i.test(h.text))) out.push('Sign up for the newsletter');
  if (/contact/.test(names)) out.push('Find the contact page');
  if (out.length < 3) out.push('Find the pricing', 'Find the contact page');
  return [...new Set(out)].slice(0, 3);
}

/** Targets to show the model: the best matches for the task first, then page order, within the budget. */
function promptTargets(task, targets, limit) {
  if (targets.length <= limit) return targets;
  const want = atExpand(atWords(task));
  const ranked = targets.map((t) => ({ t, s: atOverlap(want, `${t.name} ${t.under}`) }));
  const keep = new Set(ranked.filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, Math.floor(limit / 2)).map((x) => x.t));
  for (const t of targets) { if (keep.size >= limit) break; keep.add(t); }
  return targets.filter((t) => keep.has(t));
}

function targetLine(t) {
  const name = t.unnamed ? '(no name)' : `"${t.name.slice(0, 70)}"`;
  return `[${t.i}] ${t.role} ${name}${t.props ? ` [${t.props}]` : ''}${t.under ? ` (under "${t.under.slice(0, 40)}")` : ''}`;
}

/** 'available', 'downloadable', 'downloading' or 'unavailable'. */
async function aiAvailability() {
  if (typeof LanguageModel === 'undefined') return 'unavailable';
  try {
    return await LanguageModel.availability({ expectedInputs: AT_LANG, expectedOutputs: AT_LANG });
  } catch {
    return 'unavailable';
  }
}

/** Ask the on-device model for a plan. Must be called from a click (the first call downloads the model). */
async function aiPlan(task, r, targets, { onProgress, signal }) {
  const session = await LanguageModel.create({
    initialPrompts: [{ role: 'system', content: AT_SYSTEM }],
    expectedInputs: AT_LANG,
    expectedOutputs: AT_LANG,
    signal,
    monitor(m) {
      m.addEventListener('downloadprogress', (e) => onProgress && onProgress(e.total > 1 ? e.loaded / e.total : e.loaded));
    },
  });
  try {
    for (let limit = AT_MAX_TARGETS; limit >= 15; limit = Math.floor(limit / 2)) {
      const shown = promptTargets(task, targets, limit);
      const prompt = `Page title: ${r.title || 'Untitled'}\nElements:\n${shown.map(targetLine).join('\n')}\n\nTask: ${task}`;
      try {
        const text = await session.prompt(prompt, { responseConstraint: AT_SCHEMA, signal });
        return { ...JSON.parse(text), shown: shown.length };
      } catch (e) {
        if (e && e.name === 'QuotaExceededError') continue; // too long for the context window: fewer elements
        throw e;
      }
    }
    throw new Error(t('This page has too many controls for the on-device model.'));
  } finally {
    session.destroy();
  }
}

/** Without a model: the controls whose names best match the task. */
function matchPlan(task, targets) {
  const want = atExpand(atWords(task));
  const ranked = targets
    .map((t) => ({ t, s: atOverlap(want, t.name) * 2 + atOverlap(want, t.under) * 0.5 }))
    .filter((x) => x.s >= 1)
    .sort((a, b) => b.s - a.s);
  if (!ranked.length) {
    const unnamed = targets.filter((t) => t.unnamed).length;
    return {
      possible: false,
      steps: [],
      missing: unnamed
        ? tn(unnamed, 'No control’s name matches the task. $1 control has no name, and it may be the one you need.', 'No control’s name matches the task. $1 controls have no name, and the one you need may be among them.')
        : t('No control’s name matches the task.'),
    };
  }
  const best = ranked[0].t;
  return {
    possible: true,
    steps: [{ element: best.i, action: AT_FIELD_ROLES.has(best.role) ? 'type' : 'click' }],
    alternatives: ranked.slice(1, 3).map((x) => x.t),
  };
}

/**
 * Check the plan: steps must point at real, named controls, and nothing the
 * task needs may be hidden from agents. Returns { verdict, steps, hidden, missing }.
 */
function evaluatePlan(task, plan, targets, hidden) {
  const steps = (plan.steps || []).slice(0, 6).map((s) => {
    const target = targets.find((x) => x.i === s.element) || null;
    let problem = '';
    if (!target) problem = t('The model picked an element that isn’t on the page.');
    else if (target.unnamed) problem = t('This control has no name, so an agent would be guessing.');
    return { action: s.action || 'click', text: s.text || '', target, problem };
  });
  const want = atExpand(atWords(task));
  const hiddenHits = hidden.filter((h) => atOverlap(want, h.text) > 0);
  const usable = steps.filter((s) => s.target && !s.problem);
  let verdict;
  if (!plan.possible || !usable.length) verdict = 'fail';
  else if (steps.some((s) => s.problem) || hiddenHits.length) verdict = 'warn';
  else verdict = 'pass';
  return { verdict, steps, hidden: hiddenHits, missing: plan.possible ? '' : String(plan.missing || ''), alternatives: plan.alternatives || [] };
}

function describeTarget(x) {
  if (!x) return t('an unknown element');
  return x.unnamed ? t('$1 with no name', x.role) : t('$1 “$2”', x.role, x.name.slice(0, 60));
}
