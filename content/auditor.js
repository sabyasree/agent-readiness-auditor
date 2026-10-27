/*
 * Agent-Readiness Auditor: audit engine.
 * Injected on demand into the active tab. Runs entirely inside the page;
 * the only network requests are to /llms.txt and /robots.txt on the page's own origin.
 */
(() => {
  'use strict';

  const VERSION = '1.0.0';
  if (window.__ARA && window.__ARA.version === VERSION) return;

  const FINDING_CAP = 50;
  const SCAN_CAP = 15000;
  const FETCH_TIMEOUT_MS = 4000;

  const CATEGORIES = [
    { id: 'semantics', name: 'Real controls', weight: 20,
      description: 'Agents find things to click by their role. Controls built from plain divs and spans are invisible to them.' },
    { id: 'names', name: 'Labels and names', weight: 20,
      description: 'Every control needs a name an agent can match to an instruction like “click Add to cart”.' },
    { id: 'forms', name: 'Forms', weight: 15,
      description: 'Labeled, typed fields let agents fill forms correctly the first time.' },
    { id: 'interaction', name: 'Interaction traps', weight: 15,
      description: 'Overlays, bot challenges and embedded frames that stop agents mid-task.' },
    { id: 'stability', name: 'Stable targeting', weight: 12,
      description: 'Agents and automations re-find elements by their attributes. Generated class names and IDs change with every build.' },
    { id: 'structure', name: 'Page structure', weight: 12,
      description: 'Titles, landmarks and headings give agents a map of the page, and a lean DOM keeps it readable.' },
    { id: 'signals', name: 'Machine-readable signals', weight: 6,
      description: 'Metadata, structured data and site files that tell agents what the page is about.' },
  ];

  // ---------------------------------------------------------------- helpers

  const refs = [];
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const norm = (s) => (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim();
  const clamp01 = (n) => Math.max(0, Math.min(1, n));
  const pl = (n, one, many = one + 's') => `${n.toLocaleString()} ${n === 1 ? one : many}`;
  const vb = (n, one, many) => (n === 1 ? one : many);

  /** Score a share of bad items: 0 bad = 1.0, `tolerance` share bad = 0. */
  function ratioScore(bad, total, tolerance) {
    if (!total) return 1;
    return clamp01(1 - bad / total / tolerance);
  }
  /** Score a raw count: each issue costs `cost`. */
  function countScore(bad, cost) {
    return clamp01(1 - bad * cost);
  }

  function visible(el) {
    if (!el || !el.isConnected) return false;
    if (typeof el.checkVisibility === 'function') {
      if (!el.checkVisibility({
        checkOpacity: true, checkVisibilityCSS: true,
        opacityProperty: true, visibilityProperty: true,
      })) return false;
    } else {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  }

  /** Visible and exposed to assistive technology (which is what agents read). */
  function usable(el) {
    return visible(el) && !el.closest('[aria-hidden="true"], [inert]');
  }

  function textFromIds(ids) {
    return norm(ids.split(/\s+/).map((id) => {
      const n = document.getElementById(id);
      return n ? n.textContent : '';
    }).join(' '));
  }

  /** A practical approximation of the accessible name computation. */
  function accName(el) {
    const lb = el.getAttribute('aria-labelledby');
    if (lb) { const t = textFromIds(lb); if (t) return t; }
    const al = norm(el.getAttribute('aria-label'));
    if (al) return al;

    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (type === 'submit' || type === 'button' || type === 'reset') {
        return norm(el.value) || (type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : '');
      }
      if (type === 'image') return norm(el.getAttribute('alt'));
      if (el.labels && el.labels.length) {
        const t = norm(Array.from(el.labels).map((l) => l.innerText || l.textContent).join(' '));
        if (t) return t;
      }
      return norm(el.getAttribute('title'));
    }
    if (tag === 'IMG') return norm(el.getAttribute('alt')) || norm(el.getAttribute('title'));

    const text = norm(el.innerText || el.textContent);
    if (text) return text;
    const img = el.querySelector('img[alt]:not([alt=""])');
    if (img) return norm(img.getAttribute('alt'));
    const svgLabel = el.querySelector('svg[aria-label]');
    if (svgLabel) return norm(svgLabel.getAttribute('aria-label'));
    const svgTitle = el.querySelector('svg title');
    if (svgTitle) return norm(svgTitle.textContent);
    return norm(el.getAttribute('title'));
  }

  function labelText(el) {
    const parts = [];
    if (el.labels) for (const l of el.labels) parts.push(l.innerText || l.textContent);
    const lb = el.getAttribute('aria-labelledby');
    if (lb) parts.push(textFromIds(lb));
    parts.push(el.getAttribute('aria-label') || '');
    return norm(parts.join(' '));
  }

  function cssPath(el) {
    const uniqueId = (node) => {
      if (!node.id) return null;
      const s = '#' + CSS.escape(node.id);
      try { return document.querySelectorAll(s).length === 1 ? s : null; } catch { return null; }
    };
    const direct = uniqueId(el);
    if (direct) return direct;
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      if (node !== el) {
        const id = uniqueId(node);
        if (id) { parts.unshift(id); break; }
      }
      if (node === document.body) { parts.unshift('body'); break; }
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(' > ');
  }

  function snippet(el) {
    let open;
    try {
      const clone = el.cloneNode(false);
      for (const a of Array.from(clone.attributes)) {
        if (a.name === 'style' || a.value.length > 60) {
          clone.setAttribute(a.name, a.name === 'style' ? '…' : a.value.slice(0, 57) + '…');
        }
      }
      open = clone.outerHTML;
      const close = `</${el.tagName.toLowerCase()}>`;
      if (open.endsWith(close)) open = open.slice(0, -close.length);
    } catch {
      open = `<${el.tagName.toLowerCase()}>`;
    }
    if (!['INPUT', 'IMG', 'SELECT', 'TEXTAREA', 'IFRAME', 'svg'].includes(el.tagName)) {
      const t = norm(el.textContent);
      if (t) open += t.length > 60 ? t.slice(0, 60) + '…' : t;
    }
    return open.length > 200 ? open.slice(0, 199) + '…' : open;
  }

  function finding(el, note) {
    const ref = refs.push(el) - 1;
    let selector = '';
    try { selector = cssPath(el); } catch { /* ignore */ }
    return { ref, selector, snippet: snippet(el), note: note || '' };
  }

  function findings(items, noteFn) {
    return items.slice(0, FINDING_CAP).map((it) => {
      const el = it.el || it;
      return finding(el, noteFn ? noteFn(it) : '');
    });
  }

  const HASHY_CLASS = [
    /^css-[a-z0-9]{4,}/i,
    /^sc-[a-z0-9]{4,}/i,
    /^jsx-\d{3,}$/,
    /^svelte-[a-z0-9]{4,}$/i,
    /^_(?=[a-z]*\d)[a-z0-9]{5,}$/i,
    /_{1,2}(?=[a-z-]*\d)[a-z0-9-]{5,8}$/i,
    /^[a-z]{1,3}-[a-f0-9]{6,}$/i,
    /^(emotion|makeStyles|jss)-?\d+/i,
  ];
  function isHashyClass(t) {
    if (HASHY_CLASS.some((p) => p.test(t))) return true;
    return t.length >= 5 && t.length <= 12 && !/[-_:[\]/]/.test(t) &&
      /\d/.test(t) && /[a-z]/.test(t) && /[A-Z]/.test(t);
  }

  function isDynamicId(id) {
    return /^:r[0-9a-z]*:$|^«r[0-9a-z]+»$/i.test(id) ||
      /^(ember|yui_|ext-gen|mui-|radix-|headlessui-|react-select-|downshift-|rc_|rc-|tippy-|popover-|reach-|aria-)\S*\d/i.test(id) ||
      /[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id) ||
      /\d{4,}/.test(id) ||
      (/^[a-z0-9]{12,}$/i.test(id) && /\d/.test(id) && /[a-z]/i.test(id));
  }

  function hasStableHook(el) {
    return (el.id && !isDynamicId(el.id)) || el.getAttribute('name') ||
      el.hasAttribute('aria-label') ||
      Array.from(el.attributes).some((a) => /^data-(test|testid|test-id|qa|cy|action|track)/i.test(a.name));
  }

  const CONTROL_ROLES = new Set(['button', 'link', 'tab', 'menuitem', 'menuitemcheckbox',
    'menuitemradio', 'switch', 'option', 'checkbox', 'radio', 'treeitem']);
  const FIELD_ROLES = new Set(['textbox', 'combobox', 'searchbox', 'slider', 'spinbutton', 'listbox']);
  const NATIVE_INTERACTIVE = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY',
    'LABEL', 'OPTION', 'DETAILS', 'VIDEO', 'AUDIO', 'IFRAME', 'HTML', 'BODY']);
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'META', 'LINK', 'HEAD', 'BR', 'WBR', 'TITLE']);

  const CONTROL_SEL = 'a[href], button, summary, input[type="button"], input[type="submit"], ' +
    'input[type="reset"], input[type="image"], ' +
    Array.from(CONTROL_ROLES).map((r) => `[role="${r}"]`).join(', ');
  const FIELD_SEL = 'input:not([type="hidden"]):not([type="button"]):not([type="submit"])' +
    ':not([type="reset"]):not([type="image"]), select, textarea, [contenteditable=""], ' +
    '[contenteditable="true"], ' + Array.from(FIELD_ROLES).map((r) => `[role="${r}"]`).join(', ');
  const INSIDE_CONTROL_SEL = 'a[href], button, label, summary, select, ' +
    Array.from(CONTROL_ROLES).map((r) => `[role="${r}"]`).join(', ');
  const HAS_CONTROL_SEL = 'a[href], button, input, select, textarea, [role="button"], [role="link"]';

  function role(el) { return (el.getAttribute('role') || '').trim().toLowerCase().split(/\s+/)[0]; }

  async function fetchText(path) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(location.origin + path, {
        signal: ctrl.signal, credentials: 'omit', cache: 'no-store', redirect: 'follow',
      });
      if (!res.ok) return { found: false, status: res.status };
      const type = res.headers.get('content-type') || '';
      const text = (await res.text()).slice(0, 200000);
      if (/text\/html/i.test(type) || /^\s*</.test(text)) return { found: false, status: res.status, html: true };
      return { found: true, text };
    } finally {
      clearTimeout(timer);
    }
  }

  // ------------------------------------------------------------- page scan

  function gather() {
    const root = document.body || document.documentElement;
    const ctx = {
      vw: window.innerWidth, vh: window.innerHeight,
      elementCount: document.getElementsByTagName('*').length,
      maxDepth: 0, pointerTops: [], fixed: [], shadowHosts: [],
      controls: [], fields: [],
    };

    const controlSet = new Set();
    for (const el of $$(CONTROL_SEL)) {
      if (ctx.controls.length >= 5000) break;
      if (el.matches(FIELD_SEL)) continue;
      if (usable(el)) { controlSet.add(el); ctx.controls.push({ el, name: accName(el) }); }
    }
    for (const el of $$(FIELD_SEL)) {
      if (ctx.fields.length >= 2000) break;
      if (controlSet.has(el)) continue;
      if (el.tagName === 'INPUT' && el.closest('[role="combobox"]') && el.closest('[role="combobox"]') !== el &&
          controlSet.has(el.closest('[role="combobox"]'))) continue;
      if (usable(el)) { controlSet.add(el); ctx.fields.push({ el, name: accName(el) }); }
    }
    ctx.interactive = [...ctx.controls.map((c) => c.el), ...ctx.fields.map((f) => f.el)];
    ctx.interactiveSet = controlSet;

    // Depth-first walk: depth, fixed overlays, shadow hosts, pointer-only "controls".
    const cursorOf = new Map();
    const stack = [[root, 1]];
    let scanned = 0;
    while (stack.length) {
      const [el, depth] = stack.pop();
      if (depth > ctx.maxDepth) ctx.maxDepth = depth;
      for (let i = el.children.length - 1; i >= 0; i--) stack.push([el.children[i], depth + 1]);
      if (scanned >= SCAN_CAP || SKIP_TAGS.has(el.tagName)) continue;
      scanned++;
      if (el.shadowRoot) ctx.shadowHosts.push(el);
      if (el instanceof SVGElement && el.tagName.toLowerCase() !== 'svg') continue;
      if (!visible(el)) continue;
      const cs = getComputedStyle(el);
      cursorOf.set(el, cs.cursor);
      if (cs.position === 'fixed') ctx.fixed.push(el);

      if (NATIVE_INTERACTIVE.has(el.tagName) || controlSet.has(el)) continue;
      const r = role(el);
      if (CONTROL_ROLES.has(r) || FIELD_ROLES.has(r)) continue;
      const hasOnclick = el.hasAttribute('onclick');
      if (cs.cursor === 'pointer' || hasOnclick) {
        const parent = el.parentElement;
        const parentCursor = parent ? (cursorOf.get(parent) ?? getComputedStyle(parent).cursor) : '';
        if (hasOnclick || parentCursor !== 'pointer') ctx.pointerTops.push(el);
      }
    }
    return ctx;
  }

  // ----------------------------------------------------------------- checks

  const GENERIC_NAMES = new Set(['click here', 'here', 'learn more', 'read more', 'more', 'details',
    'more details', 'view', 'view more', 'see more', 'link', 'button', 'go', 'this', 'info',
    'more info', 'click', 'open', 'select', 'show more', 'find out more']);
  const ALWAYS_VAGUE = new Set(['click here', 'here', 'link', 'button', 'click', 'this']);

  const FIELD_HINTS = [
    { re: /e-?mail/, type: 'email', ac: 'email', what: 'an email address' },
    { re: /phone|mobile|\btel\b|telephone/, type: 'tel', ac: 'tel', what: 'a phone number' },
    { re: /website|\burl\b|homepage/, type: 'url', ac: 'url', what: 'a web address' },
    { re: /\bzip\b|zip ?code|postal|postcode/, ac: 'postal-code', what: 'a postal code' },
    { re: /first.?name|given.?name|fname/, ac: 'given-name', what: 'a first name' },
    { re: /last.?name|family.?name|surname|lname/, ac: 'family-name', what: 'a last name' },
    { re: /(^|\s)(full.?)?name(\s|$)/, ac: 'name', what: 'a name',
      unless: /company|organi[sz]ation|user.?name|file.?name|business|card/ },
    { re: /street|address line|\baddress\b/, ac: 'street-address', what: 'an address', unless: /e-?mail|ip address/ },
    { re: /\bcity\b|\btown\b/, ac: 'address-level2', what: 'a city' },
    { re: /birth|\bdob\b/, type: 'date', ac: 'bday', what: 'a date of birth' },
  ];

  const CHECKS = [
    // ---- Real controls
    {
      id: 'fake-controls', category: 'semantics', weight: 3,
      title: 'Clickable elements without a control role',
      why: 'Agents look for buttons and links in the accessibility tree. A div that only looks clickable isn’t listed there, so agents skip it or have to guess from pixels.',
      fix: 'Use a real <button> or <a href>. If that isn’t possible, add role="button", tabindex="0" and keyboard handlers.',
      run(ctx) {
        const fakes = ctx.pointerTops.filter((el) =>
          !el.closest(INSIDE_CONTROL_SEL) && !el.querySelector(HAS_CONTROL_SEL));
        const n = fakes.length;
        return {
          score: ratioScore(n, ctx.interactive.length + n, 0.25),
          issues: n,
          summary: n
            ? `${pl(n, 'element')} ${vb(n, 'looks', 'look')} clickable but ${vb(n, 'isn’t', 'aren’t')} exposed as a button or link.`
            : 'Every clickable-looking element is a real control.',
          findings: findings(fakes, (el) => el.hasAttribute('onclick')
            ? 'Has an onclick handler but no control role'
            : 'Pointer cursor, but no button or link role'),
        };
      },
    },
    {
      id: 'dead-links', category: 'semantics', weight: 2,
      title: 'Links that don’t go anywhere',
      why: 'A link promises navigation. Links with no href, “#” or “javascript:” only work through scripts, so agents may open them in a new tab, get nothing, or skip them.',
      fix: 'Give real links a destination URL. If the element performs an action instead, make it a <button>.',
      run() {
        const anchors = $$('a').filter(usable);
        const bad = anchors.filter((a) => {
          if (['button', 'tab', 'menuitem', 'option', 'switch'].includes(role(a))) return false;
          const href = a.getAttribute('href');
          if (href == null) return a.hasAttribute('onclick') || !!norm(a.textContent) || !!a.querySelector('img,svg');
          const h = href.trim();
          return h === '#' || h === '' || /^javascript:/i.test(h);
        });
        const n = bad.length;
        return {
          score: ratioScore(n, anchors.length, 0.2),
          issues: n,
          summary: n ? `${pl(n, 'link')} ${vb(n, 'has', 'have')} no real destination.` : 'All links point to real destinations.',
          findings: findings(bad, (a) => {
            const href = a.getAttribute('href');
            return href == null ? 'No href attribute' : `href="${href.trim().slice(0, 40)}"`;
          }),
        };
      },
    },
    {
      id: 'positive-tabindex', category: 'semantics', weight: 1,
      title: 'Positive tabindex values',
      why: 'tabindex above 0 overrides the natural order of the page, so agents that move with the keyboard jump around unpredictably.',
      fix: 'Use tabindex="0" or remove it, and order elements in the DOM the way they should be reached.',
      run() {
        const els = $$('[tabindex]').filter((e) => parseInt(e.getAttribute('tabindex'), 10) > 0);
        const n = els.length;
        return {
          score: countScore(n, 0.1),
          issues: n,
          summary: n ? `${pl(n, 'element')} ${vb(n, 'uses', 'use')} a positive tabindex.` : 'No positive tabindex values.',
          findings: findings(els, (e) => `tabindex="${e.getAttribute('tabindex')}"`),
        };
      },
    },

    // ---- Labels and names
    {
      id: 'unnamed-controls', category: 'names', weight: 4,
      title: 'Controls with no name',
      why: 'An agent told to “click Save” looks for a control named Save. Icon-only buttons and empty links have no name to match, so the agent has to guess.',
      fix: 'Add visible text, an aria-label, or alt text on the icon image. For SVG icons, put aria-label on the button itself.',
      run(ctx) {
        const bad = ctx.controls.filter((c) => !c.name);
        const n = bad.length;
        return {
          score: ratioScore(n, ctx.controls.length, 0.15),
          issues: n,
          summary: n
            ? `${n.toLocaleString()} of ${pl(ctx.controls.length, 'button or link', 'buttons and links')} ${vb(n, 'has', 'have')} no name.`
            : ctx.controls.length ? `All ${pl(ctx.controls.length, 'button and link', 'buttons and links')} have a name.` : 'No buttons or links on this page.',
          findings: findings(bad, (c) => c.el.querySelector('svg, img, i, [class*="icon" i]')
            ? 'Icon-only control with no label' : 'No text, aria-label or title'),
        };
      },
    },
    {
      id: 'vague-names', category: 'names', weight: 2,
      title: 'Vague or duplicated control names',
      why: 'Names like “Click here”, or ten links all called “Learn more”, don’t say where they lead. Agents can’t tell them apart without studying the layout around them.',
      fix: 'Make each name describe its target, like “Read the pricing guide”. If the visible text must stay short, add an aria-label with the full meaning.',
      run(ctx) {
        const groups = new Map();
        for (const c of ctx.controls) {
          if (!c.name) continue;
          const key = c.name.toLowerCase().replace(/[.!…:→›»]+$/u, '').trim();
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(c);
        }
        const flagged = [];
        for (const [key, list] of groups) {
          const generic = GENERIC_NAMES.has(key);
          let vague = false;
          if (ALWAYS_VAGUE.has(key) || (generic && list.length >= 2)) vague = true;
          else if (list.length >= 2) {
            const hrefs = new Set(list.filter((c) => c.el.tagName === 'A').map((c) => c.el.href.split('#')[0]));
            if (hrefs.size > 1) vague = true;
          }
          if (vague) for (const c of list) flagged.push({ el: c.el, name: c.name, count: list.length, generic });
        }
        const n = flagged.length;
        return {
          score: ratioScore(n, ctx.controls.filter((c) => c.name).length, 0.3),
          issues: n,
          summary: n ? `${pl(n, 'control')} ${vb(n, 'has a name', 'have names')} that don’t say what ${vb(n, 'it does', 'they do')}.` : 'Control names are specific and distinct.',
          findings: findings(flagged, (f) => {
            const label = f.name.length > 40 ? f.name.slice(0, 40) + '…' : f.name;
            return f.count > 1
              ? `“${label}” is used ${f.count} times for different targets`
              : `“${label}” doesn’t say what it does`;
          }),
        };
      },
    },
    {
      id: 'image-alt', category: 'names', weight: 1,
      title: 'Images without alt text',
      why: 'Agents that read the page as text see nothing for an image without alt. Product photos, charts and meaningful icons disappear.',
      fix: 'Add alt text that describes the image. For purely decorative images, use alt="" so agents can skip them.',
      run() {
        const imgs = $$('img').filter((i) => {
          if (!usable(i)) return false;
          const r = i.getBoundingClientRect();
          return r.width >= 16 && r.height >= 16 && !['presentation', 'none'].includes(role(i));
        });
        if (!imgs.length) return { score: null, status: 'na', summary: 'No images on this page.' };
        const bad = imgs.filter((i) => !i.hasAttribute('alt') && !i.hasAttribute('aria-label') && !i.hasAttribute('aria-labelledby'));
        const n = bad.length;
        return {
          score: ratioScore(n, imgs.length, 0.4),
          issues: n,
          summary: n ? `${n.toLocaleString()} of ${pl(imgs.length, 'image')} ${vb(n, 'has', 'have')} no alt attribute.` : `All ${pl(imgs.length, 'image')} have alt attributes.`,
          findings: findings(bad, (i) => {
            const src = (i.currentSrc || i.src || '').split('/').pop().split('?')[0];
            return src ? `No alt attribute (${src.slice(0, 40)})` : 'No alt attribute';
          }),
        };
      },
    },

    // ---- Forms
    {
      id: 'unlabeled-fields', category: 'forms', weight: 4,
      title: 'Form fields without labels',
      why: 'Agents fill forms by matching field labels to the information they have. A field with no label, or only placeholder text, is a guess, and placeholders vanish once typing starts.',
      fix: 'Connect a <label for> to each field, or wrap the field in a <label>. Use aria-label only when a visible label isn’t possible.',
      run(ctx) {
        if (!ctx.fields.length) return { score: null, status: 'na', summary: 'No form fields on this page.' };
        let weighted = 0;
        const bad = [];
        for (const f of ctx.fields) {
          if (f.name) continue;
          const ph = norm(f.el.getAttribute('placeholder'));
          weighted += ph ? 0.5 : 1;
          bad.push({ el: f.el, ph });
        }
        const n = bad.length;
        return {
          score: ratioScore(weighted, ctx.fields.length, 0.2),
          issues: n,
          summary: n ? `${n.toLocaleString()} of ${pl(ctx.fields.length, 'field')} ${vb(n, 'has', 'have')} no label.` : `All ${pl(ctx.fields.length, 'field')} are labeled.`,
          findings: findings(bad, (b) => b.ph ? `Only placeholder text: “${b.ph.slice(0, 40)}”` : 'No label, aria-label or title'),
        };
      },
    },
    {
      id: 'field-hints', category: 'forms', weight: 2,
      title: 'Fields missing type or autocomplete hints',
      why: 'type="email" and autocomplete="email" tell an agent exactly what a field wants. Without them it infers from nearby text and often formats the data wrong.',
      fix: 'Use the matching input type (email, tel, url, date) and add autocomplete tokens such as name, email, tel, street-address and postal-code.',
      run(ctx) {
        const textish = ctx.fields.filter((f) => {
          const el = f.el;
          if (el.tagName !== 'INPUT') return false;
          const t = (el.getAttribute('type') || 'text').toLowerCase();
          return ['text', 'email', 'tel', 'url', 'date', 'number', ''].includes(t) && !/^(q|s|search|query)$/i.test(el.name || '');
        });
        let relevant = 0;
        const bad = [];
        for (const f of textish) {
          const el = f.el;
          const hay = [el.name, el.id, el.getAttribute('autocomplete'), f.name, el.getAttribute('placeholder')]
            .filter(Boolean).join(' ').replace(/[_-]+/g, ' ').toLowerCase();
          const rule = FIELD_HINTS.find((r) => r.re.test(hay) && !(r.unless && r.unless.test(hay)));
          if (!rule) continue;
          relevant++;
          const type = (el.getAttribute('type') || 'text').toLowerCase();
          if (rule.type && type === 'text') {
            bad.push({ el, note: `Asks for ${rule.what} but type is “text” (use type="${rule.type}")` });
          } else if (!el.hasAttribute('autocomplete')) {
            bad.push({ el, note: `No autocomplete hint (add autocomplete="${rule.ac}")` });
          }
        }
        if (!relevant) return { score: null, status: 'na', summary: 'No personal-information fields that need type or autocomplete hints.' };
        const n = bad.length;
        return {
          score: ratioScore(n, relevant, 0.6),
          issues: n,
          summary: n ? `${n.toLocaleString()} of ${pl(relevant, 'personal-information field')} ${vb(n, 'is', 'are')} missing a type or autocomplete hint.` : 'Personal-information fields have the right type and autocomplete hints.',
          findings: findings(bad, (b) => b.note),
        };
      },
    },
    {
      id: 'required-fields', category: 'forms', weight: 1,
      title: 'Required fields not marked as required',
      why: 'An asterisk is only visual. Without the required attribute, agents submit forms with missing fields and then have to recover from errors.',
      fix: 'Add the required attribute, or aria-required="true", to every field the form needs.',
      run(ctx) {
        const formFields = ctx.fields.filter((f) => ['INPUT', 'SELECT', 'TEXTAREA'].includes(f.el.tagName));
        if (!formFields.length) return { score: null, status: 'na', summary: 'No form fields on this page.' };
        const bad = formFields.filter((f) => {
          const el = f.el;
          if (el.required || el.getAttribute('aria-required') === 'true') return false;
          return /\*|\(required\)|\brequired\b/i.test(labelText(el));
        });
        const n = bad.length;
        return {
          score: ratioScore(n, formFields.length, 0.3),
          issues: n,
          summary: n ? `${pl(n, 'field')} ${vb(n, 'looks', 'look')} required but ${vb(n, 'isn’t', 'aren’t')} marked as required.` : 'Fields that look required are marked as required.',
          findings: findings(bad, () => 'Label says required, but the field doesn’t'),
        };
      },
    },

    // ---- Interaction traps
    {
      id: 'overlays', category: 'interaction', weight: 3,
      title: 'Overlays covering the page',
      why: 'Cookie banners, sign-up modals and interstitials sit on top of the content. Agents often click the overlay by mistake, or can’t reach what’s underneath until it’s dismissed.',
      fix: 'Give overlays a clearly named close button, keep them away from main content, and mark modals with role="dialog", aria-modal="true" and a name.',
      run(ctx) {
        const area = ctx.vw * ctx.vh || 1;
        const main = document.querySelector('main, [role="main"]');
        const flagged = [];
        for (const el of ctx.fixed) {
          if (flagged.some((f) => f.el.contains(el))) continue;
          if (main && el.contains(main)) continue;
          const inside = ctx.interactive.filter((i) => el.contains(i)).length;
          if (ctx.interactive.length > 10 && inside / ctx.interactive.length > 0.5) continue; // app shell
          const r = el.getBoundingClientRect();
          const w = Math.max(0, Math.min(r.right, ctx.vw) - Math.max(r.left, 0));
          const h = Math.max(0, Math.min(r.bottom, ctx.vh) - Math.max(r.top, 0));
          const cover = (w * h) / area;
          const text = norm((el.innerText || '').slice(0, 600)).toLowerCase();
          const promo = /cookie|consent|privacy|newsletter|subscribe|sign up|accept all|gdpr|we use/.test(text);
          if (cover >= 0.4 || (cover >= 0.08 && promo)) {
            flagged.push({ el, note: `${promo ? 'Banner' : 'Overlay'} covering ${Math.round(cover * 100)}% of the screen` });
          }
        }
        const dialogs = $$('[role="dialog"], [role="alertdialog"], dialog[open]').filter(usable);
        const dialogIssues = [];
        for (const d of dialogs) {
          const named = textFromIds(d.getAttribute('aria-labelledby') || '') || norm(d.getAttribute('aria-label'));
          if (!named) dialogIssues.push({ el: d, note: 'Dialog has no name (add aria-labelledby or aria-label)' });
          else if (d.tagName !== 'DIALOG' && d.getAttribute('aria-modal') !== 'true' &&
                   flagged.some((f) => f.el === d || f.el.contains(d) || d.contains(f.el))) {
            dialogIssues.push({ el: d, note: 'Modal is missing aria-modal="true"' });
          }
        }
        const all = [...flagged, ...dialogIssues];
        const n = all.length;
        return {
          score: countScore(flagged.length, 0.35) * countScore(dialogIssues.length, 0.15),
          issues: n,
          summary: n
            ? [flagged.length ? `${pl(flagged.length, 'overlay')} ${vb(flagged.length, 'covers', 'cover')} the page.` : '',
               dialogIssues.length ? `${pl(dialogIssues.length, 'dialog')} ${vb(dialogIssues.length, 'is', 'are')} hard for agents to identify.` : '']
              .filter(Boolean).join(' ')
            : 'Nothing is covering the page right now.',
          findings: findings(all, (f) => f.note),
        };
      },
    },
    {
      id: 'bot-challenges', category: 'interaction', weight: 2,
      title: 'Bot challenges',
      why: 'CAPTCHAs and bot checks are built to stop automated visitors, including agents acting for a real person. A challenge on a key flow can end the task.',
      fix: 'Keep challenges off routine flows, prefer risk-based checks that rarely show a puzzle, and use your provider’s options for verified agents where available.',
      run() {
        const providers = [
          ['reCAPTCHA', 'iframe[src*="recaptcha"], .g-recaptcha, .grecaptcha-badge'],
          ['hCaptcha', 'iframe[src*="hcaptcha"], .h-captcha'],
          ['Cloudflare Turnstile', 'iframe[src*="challenges.cloudflare.com"], .cf-turnstile'],
          ['Arkose Labs', 'iframe[src*="arkoselabs"], iframe[src*="funcaptcha"]'],
          ['AWS WAF CAPTCHA', '#captcha-container, awswaf-captcha'],
        ];
        const found = [];
        for (const [name, sel] of providers) {
          for (const el of $$(sel)) {
            if (el.isConnected && !found.some((f) => f.el === el || f.el.contains(el))) found.push({ el, name });
          }
        }
        const names = [...new Set(found.map((f) => f.name))];
        return {
          score: found.length ? 0.5 : 1,
          status: found.length ? 'warn' : 'pass',
          issues: found.length,
          summary: found.length ? `Found ${names.join(' and ')} on this page.` : 'No CAPTCHA or bot challenge found on this page.',
          findings: findings(found, (f) => f.name),
        };
      },
    },
    {
      id: 'frames', category: 'interaction', weight: 2,
      title: 'Content inside cross-origin frames',
      why: 'Agents and their tools often can’t read or click inside iframes from another domain. Checkout, login or booking widgets embedded this way can be unreachable.',
      fix: 'Host key flows on your own domain, or use your provider’s redirect or API option instead of an embedded frame.',
      run() {
        const skip = /recaptcha|hcaptcha|challenges\.cloudflare|doubleclick|googlesyndication|adservice|youtube|youtube-nocookie|vimeo|player\.|spotify|twitter|facebook\.com\/plugins|googletagmanager/i;
        const bad = [];
        for (const f of $$('iframe').filter(usable)) {
          const r = f.getBoundingClientRect();
          if (r.width < 150 || r.height < 80) continue;
          const src = f.getAttribute('src') || '';
          if (skip.test(src)) continue;
          let crossOrigin = false;
          try { crossOrigin = !f.contentDocument; } catch { crossOrigin = true; }
          if (!crossOrigin) continue;
          let host = 'another site';
          try { host = new URL(src, location.href).hostname || host; } catch { /* ignore */ }
          bad.push({ el: f, note: `Frame from ${host} (${Math.round(r.width)}×${Math.round(r.height)})` });
        }
        const n = bad.length;
        return {
          score: countScore(n, 0.25),
          issues: n,
          summary: n ? `${pl(n, 'cross-origin frame')} ${vb(n, 'holds', 'hold')} content agents may not reach.` : 'No content is embedded in cross-origin frames.',
          findings: findings(bad, (b) => b.note),
        };
      },
    },
    {
      id: 'small-targets', category: 'interaction', weight: 1,
      title: 'Very small click targets',
      why: 'Agents that work from screenshots click by coordinates. Tiny targets, smaller than 24 × 24 pixels or thinner than 16 pixels, are easy to miss or to confuse with their neighbours.',
      fix: 'Make clickable areas at least 24 × 24 pixels, using padding if the visible icon is smaller.',
      run(ctx) {
        const candidates = ctx.interactive.filter((el) => {
          if (el.tagName === 'OPTION') return false;
          const t = (el.getAttribute('type') || '').toLowerCase();
          if ((t === 'checkbox' || t === 'radio') && el.labels && el.labels.length) return false;
          if (el.tagName === 'A') {
            const block = el.parentElement && el.parentElement.closest('p, li, td, dd, blockquote, figcaption, label');
            if (block && norm(block.innerText).length > norm(el.innerText).length + 20) return false; // inline text link
          }
          return true;
        });
        const bad = [];
        for (const el of candidates) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0 && ((r.width < 24 && r.height < 24) || Math.min(r.width, r.height) < 16)) bad.push({ el, w: r.width, h: r.height });
        }
        const n = bad.length;
        return {
          score: ratioScore(n, candidates.length, 0.3),
          issues: n,
          summary: n ? `${pl(n, 'control')} ${vb(n, 'is', 'are')} too small to hit reliably.` : 'Click targets are a comfortable size.',
          findings: findings(bad, (b) => `${Math.round(b.w)} × ${Math.round(b.h)} px`),
        };
      },
    },
    {
      id: 'shadow-dom', category: 'interaction', weight: 0, info: true,
      title: 'Controls inside shadow DOM',
      why: 'Shadow DOM hides elements from ordinary selectors. Many agents handle open shadow roots, but scripts and some tools don’t, and closed shadow roots are hidden from all of them.',
      fix: 'Make sure web components expose their names and roles. This audit doesn’t look inside shadow roots, so test those controls separately.',
      run(ctx) {
        const hosts = ctx.shadowHosts.filter((h) => h.shadowRoot);
        if (!hosts.length) return { score: null, status: 'pass', issues: 0, summary: 'No shadow DOM components found.' };
        let inner = 0;
        for (const h of hosts) {
          try { inner += h.shadowRoot.querySelectorAll(`${CONTROL_SEL}, ${FIELD_SEL}`).length; } catch { /* ignore */ }
        }
        return {
          score: null, status: 'info', issues: hosts.length,
          summary: `${pl(hosts.length, 'component')} ${vb(hosts.length, 'uses', 'use')} shadow DOM${inner ? `, containing ${pl(inner, 'control')} this audit didn’t check` : ''}.`,
          findings: findings(hosts, (h) => `<${h.tagName.toLowerCase()}> with an open shadow root`),
        };
      },
    },

    // ---- Stable targeting
    {
      id: 'generated-classes', category: 'stability', weight: 2,
      title: 'Controls identified only by generated class names',
      why: 'Class names like css-1x2y3z or Button_root__a8F3k change whenever the site is rebuilt. Agents and automations that remember these selectors break after every release.',
      fix: 'Add a stable hook to important controls: a meaningful id, a name, or a data attribute such as data-testid or data-action.',
      run(ctx) {
        const withClass = ctx.interactive.filter((el) => typeof el.className === 'string' && el.classList.length);
        if (withClass.length < 3) return { score: null, status: 'na', summary: 'Too few styled controls to judge.' };
        const bad = withClass.filter((el) => Array.from(el.classList).every(isHashyClass) && !hasStableHook(el));
        const n = bad.length;
        return {
          score: ratioScore(n, withClass.length, 0.5),
          issues: n,
          summary: n ? `${n.toLocaleString()} of ${pl(withClass.length, 'control')} can only be targeted by generated class names.` : 'Controls don’t depend on generated class names.',
          findings: findings(bad, (el) => `class="${Array.from(el.classList).slice(0, 3).join(' ')}"`),
        };
      },
    },
    {
      id: 'dynamic-ids', category: 'stability', weight: 2,
      title: 'Auto-generated IDs',
      why: 'IDs like :r4: or input-83412 are created at runtime and change between visits. Selectors and label links that point at them are fragile.',
      fix: 'Give important controls readable, permanent IDs, or rely on name and data-testid attributes instead.',
      run(ctx) {
        const withId = ctx.interactive.filter((el) => el.id);
        if (!withId.length) return { score: null, status: 'na', summary: 'No controls on this page have IDs.' };
        const bad = withId.filter((el) => isDynamicId(el.id));
        const n = bad.length;
        return {
          score: ratioScore(n, withId.length, 0.5),
          issues: n,
          summary: n ? `${n.toLocaleString()} of ${pl(withId.length, 'control ID')} look auto-generated.` : 'Control IDs look stable.',
          findings: findings(bad, (el) => `id="${el.id.slice(0, 50)}"`),
        };
      },
    },

    // ---- Page structure
    {
      id: 'page-title', category: 'structure', weight: 2,
      title: 'Descriptive page title',
      why: 'The title is often the first thing an agent reads to confirm it’s on the right page, and it’s how the agent tells tabs apart.',
      fix: 'Write a unique title that names the page and the site, like “Order history | Acme”.',
      run() {
        const t = norm(document.title);
        const generic = /^(home|untitled|document|index|page|react app|vite app|vite \+ react|new tab|loading\.*|welcome)$/i.test(t);
        if (!t) return { score: 0, issues: 1, summary: 'This page has no title.' };
        if (generic || t.length < 4) return { score: 0.5, issues: 1, summary: `The title “${t}” doesn’t describe this page.` };
        return { score: 1, issues: 0, summary: `Title: “${t.length > 90 ? t.slice(0, 90) + '…' : t}”` };
      },
    },
    {
      id: 'page-language', category: 'structure', weight: 1,
      title: 'Page language declared',
      why: 'The lang attribute tells agents which language to read and write in, which matters for form input, translation and dates.',
      fix: 'Set lang on the <html> element, like <html lang="en">.',
      run() {
        const lang = norm(document.documentElement.getAttribute('lang'));
        if (!lang) return { score: 0, issues: 1, summary: 'The <html> element has no lang attribute.' };
        if (!/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(lang)) return { score: 0.5, issues: 1, summary: `lang="${lang}" isn’t a valid language code.` };
        return { score: 1, issues: 0, summary: `Language: ${lang}` };
      },
    },
    {
      id: 'landmarks', category: 'structure', weight: 2,
      title: 'Main content and navigation landmarks',
      why: 'Landmarks let an agent jump straight to the main content or the site navigation instead of reading the whole page in order.',
      fix: 'Wrap the primary content in <main> and site navigation in <nav>, and use <header> and <footer> for page chrome.',
      run(ctx) {
        const mains = $$('main, [role="main"]').filter(visible);
        const navs = $$('nav, [role="navigation"]');
        const linkCount = ctx.controls.filter((c) => c.el.tagName === 'A').length;
        const needsNav = linkCount >= 8;
        let score = 0;
        const missing = [];
        if (mains.length === 1) score += 0.7; else if (mains.length > 1) score += 0.5; else missing.push('main landmark');
        if (navs.length || !needsNav) score += 0.3; else missing.push('navigation landmark');
        const out = [];
        if (mains.length > 1) out.push(...mains.map((el) => ({ el, note: `One of ${mains.length} visible main landmarks` })));
        return {
          score,
          issues: missing.length + (mains.length > 1 ? 1 : 0),
          summary: missing.length
            ? `No ${missing.join(' and no ')} found.`
            : mains.length > 1 ? `This page has ${mains.length} visible main landmarks; it should have one.` : 'Main content and navigation are marked up as landmarks.',
          findings: findings(out, (o) => o.note),
        };
      },
    },
    {
      id: 'headings', category: 'structure', weight: 2,
      title: 'Heading outline',
      why: 'Headings are how agents skim. One clear h1 and a logical outline let them find the right section quickly.',
      fix: 'Use one h1 for the page topic, and step down one level at a time (h2, then h3) without skipping levels.',
      run() {
        const hs = $$('h1, h2, h3, h4, h5, h6, [role="heading"]').filter(usable).map((el) => ({
          el,
          level: /^H[1-6]$/.test(el.tagName) ? Number(el.tagName[1]) : Number(el.getAttribute('aria-level')) || 2,
        }));
        if (!hs.length) return { score: 0.3, issues: 1, summary: 'This page has no headings.' };
        const issues = [];
        const h1s = hs.filter((h) => h.level === 1);
        if (h1s.length > 1) h1s.forEach((h) => issues.push({ el: h.el, note: `One of ${h1s.length} h1 headings` }));
        let prev = 0;
        for (const h of hs) {
          if (prev && h.level > prev + 1) issues.push({ el: h.el, note: `Jumps from h${prev} to h${h.level}` });
          prev = h.level;
        }
        const noH1 = h1s.length === 0;
        const n = issues.length + (noH1 ? 1 : 0);
        const parts = [];
        if (noH1) parts.push('There’s no h1.');
        if (h1s.length > 1) parts.push(`There are ${h1s.length} h1 headings.`);
        const skips = issues.filter((i) => i.note.startsWith('Jumps')).length;
        if (skips) parts.push(`The outline skips a level ${pl(skips, 'time')}.`);
        return {
          score: countScore(issues.length, 0.08) * (noH1 ? 0.7 : 1),
          issues: n,
          summary: n ? parts.join(' ') : `${pl(hs.length, 'heading')} in a clean outline.`,
          findings: findings(issues, (i) => i.note),
        };
      },
    },
    {
      id: 'dom-size', category: 'structure', weight: 1,
      title: 'Page size and nesting',
      why: 'Agents read a trimmed copy of the page within a limited context. Very large or deeply nested pages get cut off, so content near the end may never be seen.',
      fix: 'Remove hidden duplicate markup, virtualize long lists, and flatten wrappers that only exist for styling.',
      run(ctx) {
        const c = ctx.elementCount;
        let score = c <= 2500 ? 1 : c <= 5000 ? 0.85 : c <= 10000 ? 0.65 : c <= 20000 ? 0.45 : 0.25;
        if (ctx.maxDepth > 32) score *= 0.85;
        return {
          score,
          issues: score < 0.95 ? 1 : 0,
          summary: `${pl(c, 'element')}, nested up to ${ctx.maxDepth} levels deep.`,
        };
      },
    },

    // ---- Machine-readable signals
    {
      id: 'metadata', category: 'signals', weight: 2,
      title: 'Description and link metadata',
      why: 'A meta description and Open Graph tags give agents a one-line summary of the page before they read it, and help them cite it correctly.',
      fix: 'Add <meta name="description">, og:title, og:description, and a <link rel="canonical"> pointing at the preferred URL.',
      run() {
        const has = (sel) => !!norm(document.querySelector(sel)?.getAttribute('content') || document.querySelector(sel)?.getAttribute('href'));
        const items = [
          ['a meta description', 'meta[name="description" i]', 0.4],
          ['og:title', 'meta[property="og:title"]', 0.2],
          ['og:description', 'meta[property="og:description"]', 0.15],
          ['a canonical link', 'link[rel="canonical"]', 0.25],
        ];
        let score = 0;
        const missing = [];
        for (const [label, sel, w] of items) { if (has(sel)) score += w; else missing.push(label); }
        return {
          score,
          issues: missing.length,
          summary: missing.length ? `Missing ${missing.join(', ').replace(/, ([^,]*)$/, ' and $1')}.` : 'Description, Open Graph and canonical tags are all present.',
        };
      },
    },
    {
      id: 'structured-data', category: 'signals', weight: 2,
      title: 'Structured data',
      why: 'Schema.org data states facts like price, availability, author and dates in a form agents can read without interpreting the layout.',
      fix: 'Add JSON-LD for the page’s main subject, such as Product, Article, Organization, Event or FAQPage.',
      run() {
        const types = new Set();
        const broken = [];
        const collect = (node) => {
          if (!node || typeof node !== 'object') return;
          if (Array.isArray(node)) { node.forEach(collect); return; }
          const t = node['@type'];
          if (t) (Array.isArray(t) ? t : [t]).forEach((x) => types.add(String(x)));
          if (node['@graph']) collect(node['@graph']);
        };
        for (const s of $$('script[type="application/ld+json"]')) {
          try { collect(JSON.parse(s.textContent)); } catch { broken.push(s); }
        }
        const micro = document.querySelectorAll('[itemscope][itemtype]').length;
        let score;
        let summary;
        if (types.size) {
          score = broken.length ? 0.75 : 1;
          const list = [...types].slice(0, 6).join(', ');
          summary = `Found JSON-LD: ${list}${types.size > 6 ? ', …' : ''}.`;
        } else if (micro) {
          score = broken.length ? 0.6 : 0.85;
          summary = `Found ${pl(micro, 'microdata item')}, but no JSON-LD.`;
        } else {
          score = broken.length ? 0.4 : 0.7;
          summary = 'No structured data found.';
        }
        if (broken.length) summary += ` ${pl(broken.length, 'JSON-LD block')} couldn’t be parsed.`;
        return {
          score,
          issues: broken.length + (types.size ? 0 : 1),
          summary,
          findings: findings(broken, () => 'Invalid JSON'),
        };
      },
    },
    {
      id: 'llms-txt', category: 'signals', weight: 1,
      title: 'llms.txt file',
      why: 'llms.txt is an emerging convention: a plain-text guide to a site, written for language models. Few sites have one yet, so it’s an inexpensive way to help agents.',
      fix: 'Publish /llms.txt at the root of the site with a short description and Markdown links to its most useful pages.',
      async run() {
        try {
          const r = await fetchText('/llms.txt');
          if (r.found) {
            const lines = r.text.split('\n').filter((l) => l.trim()).length;
            return { score: 1, issues: 0, summary: `Found ${location.origin}/llms.txt (${pl(lines, 'line')}).` };
          }
          return { score: 0.75, status: 'warn', issues: 1, summary: `No llms.txt at ${location.origin}/llms.txt.` };
        } catch (e) {
          return { score: null, status: 'na', summary: 'Couldn’t check for llms.txt from this page.' };
        }
      },
    },
    {
      id: 'robots-ai', category: 'signals', weight: 1,
      title: 'robots.txt rules for AI agents',
      why: 'Some agents check robots.txt before acting for a person. Blocking user-triggered agents such as ChatGPT-User or Claude-User can stop them from opening your pages at all.',
      fix: 'Decide deliberately which agents to allow. Blocking training crawlers (GPTBot, ClaudeBot, Google-Extended) is separate from blocking agents that browse on someone’s behalf.',
      async run() {
        let r;
        try { r = await fetchText('/robots.txt'); } catch {
          return { score: null, status: 'na', summary: 'Couldn’t check robots.txt from this page.' };
        }
        if (!r.found) return { score: 1, issues: 0, summary: 'No robots.txt found, so no agents are blocked.' };
        const groups = parseRobots(r.text);
        const path = location.pathname + location.search;
        const userAgents = ['ChatGPT-User', 'Claude-User', 'Perplexity-User'];
        const crawlers = ['GPTBot', 'ClaudeBot', 'Google-Extended', 'PerplexityBot', 'CCBot', 'Applebot-Extended'];
        const blockedUsers = userAgents.filter((a) => isBlocked(groups, a.toLowerCase(), path));
        const blockedCrawlers = crawlers.filter((a) => isBlocked(groups, a.toLowerCase(), path));
        const parts = [];
        if (blockedUsers.length) parts.push(`Blocks agents browsing for a person: ${blockedUsers.join(', ')}.`);
        if (blockedCrawlers.length) parts.push(`Blocks crawlers: ${blockedCrawlers.join(', ')}.`);
        return {
          score: blockedUsers.length ? 0.5 : 1,
          status: blockedUsers.length ? 'warn' : 'pass',
          issues: blockedUsers.length,
          summary: parts.length ? parts.join(' ') : 'robots.txt allows AI agents on this page.',
        };
      },
    },
  ];

  function parseRobots(text) {
    const groups = [];
    let cur = null;
    let lastWasAgent = false;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/#.*/, '').trim();
      if (!line) continue;
      const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
      if (!m) continue;
      const key = m[1].toLowerCase();
      const val = m[2].trim();
      if (key === 'user-agent') {
        if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
        cur.agents.push(val.toLowerCase());
        lastWasAgent = true;
      } else {
        lastWasAgent = false;
        if (cur && (key === 'allow' || key === 'disallow')) cur.rules.push({ allow: key === 'allow', path: val });
      }
    }
    return groups;
  }

  function isBlocked(groups, agent, path) {
    let matched = groups.filter((g) => g.agents.includes(agent));
    if (!matched.length) matched = groups.filter((g) => g.agents.includes('*'));
    let best = null;
    for (const rule of matched.flatMap((g) => g.rules)) {
      if (!rule.path) continue;
      const pattern = '^' + rule.path.replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      let re;
      try { re = new RegExp(pattern); } catch { continue; }
      if (!re.test(path)) continue;
      const len = rule.path.length;
      if (!best || len > best.len || (len === best.len && rule.allow)) best = { len, allow: rule.allow };
    }
    return !!best && !best.allow;
  }

  // ------------------------------------------------------------------- run

  const GRADES = [
    [90, 'Agent-ready', 'Agents should be able to read this page and complete most tasks on it.'],
    [75, 'Mostly ready', 'Agents can use this page, but a few issues will slow them down or cause mistakes.'],
    [50, 'Needs work', 'Agents will struggle with parts of this page. Start with the failing checks.'],
    [0, 'Hard for agents', 'Agents are likely to get stuck here. The failing checks below are the biggest blockers.'],
  ];

  function statusFor(check, out) {
    if (out.status) return out.status;
    if (out.score == null) return 'na';
    if (check.info) return 'info';
    let s = out.score >= 0.95 ? 'pass' : out.score >= 0.7 ? 'warn' : 'fail';
    if (s === 'pass' && out.issues > 0) s = 'warn';
    return s;
  }

  async function run() {
    const started = performance.now();
    refs.length = 0;
    const runId = Math.random().toString(36).slice(2, 10);
    window.__ARA.runId = runId;

    const ctx = gather();

    const checks = await Promise.all(CHECKS.map(async (c) => {
      let out;
      try {
        out = await c.run(ctx);
      } catch (e) {
        out = { score: null, status: 'na', summary: `This check couldn’t run on this page (${(e && e.message) || e}).` };
      }
      const list = out.findings || [];
      const status = statusFor(c, out);
      return {
        id: c.id, category: c.category, title: c.title, why: c.why, fix: c.fix, weight: c.weight,
        status,
        score: out.score == null ? null : Math.round(out.score * 100),
        issues: out.issues ?? list.length,
        summary: out.summary || '',
        findings: list,
      };
    }));

    const categories = CATEGORIES.map((cat) => {
      const own = checks.filter((c) => c.category === cat.id);
      const scored = own.filter((c) => c.score != null && c.weight > 0 && (c.status === 'pass' || c.status === 'warn' || c.status === 'fail'));
      const wsum = scored.reduce((a, c) => a + c.weight, 0);
      const score = wsum ? Math.round(scored.reduce((a, c) => a + c.score * c.weight, 0) / wsum) : null;
      return { id: cat.id, name: cat.name, description: cat.description, weight: cat.weight, score, checks: own };
    });

    const scoredCats = categories.filter((c) => c.score != null);
    const cw = scoredCats.reduce((a, c) => a + c.weight, 0);
    const score = cw ? Math.round(scoredCats.reduce((a, c) => a + c.score * c.weight, 0) / cw) : 0;
    const grade = GRADES.find((g) => score >= g[0]);

    const counts = { pass: 0, warn: 0, fail: 0, info: 0, na: 0 };
    for (const c of checks) counts[c.status] = (counts[c.status] || 0) + 1;

    return {
      tool: 'Agent-Readiness Auditor',
      version: VERSION,
      runId,
      url: location.href,
      title: document.title,
      timestamp: Date.now(),
      durationMs: Math.round(performance.now() - started),
      score,
      grade: grade[1],
      gradeText: grade[2],
      counts,
      stats: {
        elements: ctx.elementCount,
        depth: ctx.maxDepth,
        controls: ctx.controls.length,
        fields: ctx.fields.length,
      },
      categories,
    };
  }

  window.__ARA = { version: VERSION, run, refs, runId: null };
})();
