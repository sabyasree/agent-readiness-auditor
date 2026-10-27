/*
 * Agent-Readiness Auditor: audit engine.
 * Injected on demand into the active tab. Runs entirely inside the page;
 * the only network requests go to the page's own origin: the page URL itself
 * (to compare the server HTML with the rendered page, and to ask for Markdown),
 * /llms.txt, /robots.txt, /sitemap.xml and a few /.well-known/ discovery files.
 */
(() => {
  'use strict';

  const VERSION = '1.3.0';
  if (window.__ARA && window.__ARA.version === VERSION) return;

  const FINDING_CAP = 50;
  const SCAN_CAP = 15000;
  const FETCH_TIMEOUT_MS = 4000;
  const VIEW_CAP = 4000;
  const VIEW_SCAN_CAP = 40000;

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
    { id: 'safety', name: 'Agent safety', weight: 6,
      description: 'Hidden text that tries to give agents instructions. Agents may follow it, or flag the whole site as unsafe.' },
    { id: 'commerce', name: 'Shopping agents', weight: 10,
      description: 'Scored only on product pages. AI shopping agents compare products from structured data and buy through the cart button.' },
    { id: 'signals', name: 'Machine-readable signals', weight: 6,
      description: 'Metadata, structured data and site files that tell agents what the page is about.' },
    { id: 'protocols', name: 'Agent protocols', weight: 0, scored: false,
      description: 'Newer standards that let agents discover Markdown, APIs and tools. Few sites publish them and few agents read them yet, so they’re shown for information and don’t affect the score.' },
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

  const pageUrl = () => location.href.split('#')[0];

  // One request per URL and Accept header per run, shared between checks.
  const fetchCache = new Map();
  function fetchRes(url, { accept = '', credentials = 'omit', timeout = FETCH_TIMEOUT_MS, max = 200000 } = {}) {
    const key = `${url}|${accept}|${credentials}`;
    if (!fetchCache.has(key)) {
      fetchCache.set(key, (async () => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeout);
        try {
          const res = await fetch(url, {
            signal: ctrl.signal, credentials, cache: 'no-store', redirect: 'follow',
            headers: accept ? { Accept: accept } : undefined,
          });
          const text = (await res.text()).slice(0, max);
          return {
            ok: res.ok, status: res.status, text,
            type: res.headers.get('content-type') || '',
            link: res.headers.get('link') || '',
          };
        } finally {
          clearTimeout(timer);
        }
      })());
    }
    return fetchCache.get(key);
  }

  async function fetchText(path) {
    const r = await fetchRes(location.origin + path);
    if (!r.ok) return { found: false, status: r.status };
    if (/text\/html/i.test(r.type) || /^\s*</.test(r.text)) return { found: false, status: r.status, html: true };
    return { found: true, text: r.text };
  }

  /** A JSON file at `path`, or null. Sites that answer every URL with their HTML app shell don't count. */
  async function fetchJson(path) {
    let r;
    try { r = await fetchRes(location.origin + path); } catch { return null; }
    if (!r.ok || /text\/html/i.test(r.type) || !/^\s*[[{]/.test(r.text)) return null;
    try { return { data: JSON.parse(r.text) }; } catch { return { invalid: true }; }
  }

  /** Text content a no-JavaScript reader would get, skipping scripts and styles. */
  function textOf(root, live) {
    if (!root) return '';
    const skip = live ? 'script, style, template, noscript, [data-agent-readiness-highlight]' : 'script, style, template';
    const parts = [];
    const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      if (t.parentElement && !t.parentElement.closest(skip)) parts.push(t.data);
    }
    return parts.join(' ');
  }
  const wordCount = (t) => (t.match(/[\p{L}\p{N}]+/gu) || []).length;
  const squashText = (t) => norm(t).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

  /** Buffered layout-shift entries since the page loaded, or null if unsupported. */
  function layoutShifts() {
    return new Promise((resolve) => {
      if (!window.PerformanceObserver || !(PerformanceObserver.supportedEntryTypes || []).includes('layout-shift')) return resolve(null);
      const list = [];
      let po;
      try {
        po = new PerformanceObserver((l) => list.push(...l.getEntries()));
        po.observe({ type: 'layout-shift', buffered: true });
      } catch { return resolve(null); }
      setTimeout(() => {
        try { list.push(...po.takeRecords()); po.disconnect(); } catch { /* ignore */ }
        resolve(list);
      }, 150);
    });
  }

  // Wording typical of prompt injection: overriding instructions, or addressing the AI directly.
  const INJECTION = [
    /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any|your|other)\b[^.\n]{0,30}\b(instructions?|prompts?|rules|directions|guidelines|context)\b/i,
    /\b(you are|you're|act as|pretend to be|role-?play as)\s+(an?\s+)?(ai|artificial intelligence|assistant|language model|llm|chatbot|agent|gpt|chatgpt|claude|gemini)\b/i,
    /\b(note|message|instructions?|attention)\s+(to|for)\s+(the\s+)?(ai|llms?|language models?|assistants?|agents?|chatgpt|claude|gemini|bots?)\b/i,
    /\b(if|when)\s+(you are|you're)\s+an?\s+(ai|llm|language model|assistant|agent|bot)\b/i,
    /\b(ai|llm|language model|ai assistant|ai agent|chatgpt|claude|gemini)s?\s*[,:]\s*(you\s+)?(must|should|need to|do not|don't|never|always|instead)\b/i,
    /\b(system prompt|developer message|new instructions|hidden instructions)\b/i,
    /<\|?(im_start|im_end|endoftext)\|?>|\[\/?INST\]|<<SYS>>/i,
    /\b(reveal|print|repeat)\s+(your|the)\s+(system\s+)?(prompt|instructions)\b/i,
  ];

  /** How an element's text is hidden from people, or '' if they can see it. */
  function hiddenHow(el) {
    if (!rendered(el)) return 'Hidden text';
    const cs = getComputedStyle(el);
    if (parseFloat(cs.opacity) === 0 || (typeof el.checkVisibility === 'function' && !el.checkVisibility({ opacityProperty: true }))) return 'Transparent text';
    if (parseFloat(cs.fontSize) < 3) return 'Tiny text';
    const rgba = (c) => (c.match(/[\d.]+/g) || []).map(Number);
    const fg = rgba(cs.color);
    if (fg.length === 4 && fg[3] === 0) return 'Transparent text';
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1 || /rect\(0(px)?,? 0(px)?,? 0(px)?,? 0(px)?\)|inset\(50%\)/.test(cs.clip + cs.clipPath)) return 'Visually hidden text';
    const docW = document.documentElement.scrollWidth;
    if (r.right < 0 || r.bottom < -window.scrollY || r.left > docW) return 'Text positioned off-screen';
    for (let a = el; a; a = a.parentElement) {
      const bg = rgba(getComputedStyle(a).backgroundColor);
      if (bg.length === 3 || (bg.length === 4 && bg[3] > 0.9)) {
        if (fg.slice(0, 3).every((v, i) => Math.abs(v - bg[i]) < 12)) return 'Text the same color as its background';
        break;
      }
    }
    return '';
  }

  /** Every JSON-LD object on the page, with @graph and arrays flattened. */
  function jsonLdNodes() {
    const out = [];
    const walk = (n) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach(walk); return; }
      out.push(n);
      if (n['@graph']) walk(n['@graph']);
      if (n.hasVariant) walk(n.hasVariant);
    };
    for (const s of $$('script[type="application/ld+json"]')) {
      try { walk(JSON.parse(s.textContent)); } catch { /* reported by structured-data */ }
    }
    return out;
  }
  const typeIs = (n, t) => [].concat(n['@type'] || []).some((x) => String(x).replace(/^.*[/#]/, '').toLowerCase() === t.toLowerCase());
  const listJoin = (items, word = 'and') => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} ${word} ${items[items.length - 1]}`);

  // "Add to cart", "Add to bag – $98", "Add Tree Runner to cart", "Buy now".
  const CART_NAME = /\badd\b.{0,60}?\bto (your |the )?(cart|bag|basket|trolley|order)\b|\bbuy (it )?now\b|\badd item\b/i;

  /** What the page offers shopping agents. Computed once per run. */
  function commerceInfo(ctx) {
    if (ctx.commerce) return ctx.commerce;
    const nodes = jsonLdNodes();
    // Prefer a ProductGroup (variants of one product) and fill gaps from its first
    // variant; otherwise the fullest Product. Bare stubs like itemReviewed lose.
    const richness = (n) => ['name', 'image', 'description', 'brand', 'offers', 'sku', 'gtin13', 'mpn'].filter((k) => n[k]).length;
    const group = nodes.find((n) => typeIs(n, 'ProductGroup'));
    const products = nodes.filter((n) => typeIs(n, 'Product')).sort((a, b) => richness(b) - richness(a));
    let product = null;
    if (group) product = { ...([].concat(group.hasVariant || [])[0] || {}), ...group };
    else if (products.length) product = products[0];
    if (product && !product.aggregateRating) {
      const rated = nodes.find((n) => n.aggregateRating || typeIs(n, 'AggregateRating'));
      if (rated) product.aggregateRating = rated.aggregateRating || rated;
    }
    let offer = null;
    if (product) {
      const offers = [].concat(product.offers || []);
      const variantOffers = [].concat(product.hasVariant || []).flatMap((v) => [].concat((v && v.offers) || []));
      offer = offers[0] || variantOffers[0] || null;
      if (offer && typeIs(offer, 'AggregateOffer') && offer.offers) offer = { ...[].concat(offer.offers)[0], ...offer };
    }
    const micro = !!document.querySelector('[itemscope][itemtype*="schema.org/Product" i]');
    const og = /product/i.test(document.querySelector('meta[property="og:type"]')?.getAttribute('content') || '');
    const cart = ctx.controls.filter((c) => CART_NAME.test(c.name));
    const fakeCart = ctx.pointerTops.filter((el) => !el.closest(INSIDE_CONTROL_SEL) && CART_NAME.test(norm(el.innerText).slice(0, 60)));
    const listing = !product && cart.length + fakeCart.length > 2;
    const isProduct = !!(product || micro || og) || (!listing && cart.length + fakeCart.length > 0);
    ctx.commerce = { nodes, product, offer, micro, cart, fakeCart, listing, isProduct };
    return ctx.commerce;
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

  // ------------------------------------------------------------- agent view

  const ARIA_ROLES = new Set(('alert alertdialog application article banner blockquote button caption cell ' +
    'checkbox code columnheader combobox comment complementary contentinfo definition deletion dialog directory ' +
    'document emphasis feed figure form generic grid gridcell group heading img image insertion link list listbox ' +
    'listitem log main mark marquee math menu menubar menuitem menuitemcheckbox menuitemradio meter navigation none ' +
    'note option paragraph presentation progressbar radio radiogroup region row rowgroup rowheader scrollbar search ' +
    'searchbox separator slider spinbutton status strong subscript suggestion superscript switch tab table tablist ' +
    'tabpanel term textbox time timer toolbar tooltip tree treegrid treeitem').split(' '));
  const validRole = (r) => ARIA_ROLES.has(r) || /^(doc|graphics)-[a-z]+$/.test(r);

  // Roles an agent reads as one item: the name says it all, so children aren't listed.
  const LEAF_ROLES = new Set(['link', 'button', 'heading', 'checkbox', 'radio', 'switch', 'tab', 'menuitem',
    'menuitemcheckbox', 'menuitemradio', 'option', 'treeitem', 'textbox', 'searchbox', 'combobox', 'spinbutton',
    'slider', 'img', 'image', 'progressbar', 'meter', 'separator', 'iframe']);
  const CONTAINER_ROLES = new Set(['banner', 'navigation', 'main', 'complementary', 'contentinfo', 'search', 'form',
    'region', 'dialog', 'alertdialog', 'list', 'listitem', 'table', 'row', 'cell', 'gridcell', 'columnheader',
    'rowheader', 'group', 'radiogroup', 'tablist', 'tabpanel', 'menu', 'menubar', 'toolbar', 'tree', 'grid',
    'treegrid', 'listbox', 'paragraph', 'article', 'figure', 'alert', 'status', 'blockquote', 'note', 'feed', 'log']);
  const NEEDS_NAME = new Set([...CONTROL_ROLES, ...FIELD_ROLES, 'img', 'image', 'iframe', 'dialog', 'alertdialog']);
  const SECTIONING = 'article, aside, main, nav, section, [role="article"], [role="complementary"], [role="main"], [role="navigation"], [role="region"]';

  function explicitName(el) {
    const lb = el.getAttribute('aria-labelledby');
    return (lb && textFromIds(lb)) || norm(el.getAttribute('aria-label'));
  }

  function implicitRole(el) {
    const t = el.tagName;
    switch (t) {
      case 'A': case 'AREA': return el.hasAttribute('href') ? 'link' : '';
      case 'BUTTON': case 'SUMMARY': return 'button';
      case 'INPUT': {
        const type = (el.getAttribute('type') || 'text').toLowerCase();
        const map = { button: 'button', submit: 'button', reset: 'button', image: 'button', file: 'button',
          color: 'button', checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton', hidden: '' };
        if (type in map) return map[type];
        if (el.hasAttribute('list')) return 'combobox';
        return type === 'search' ? 'searchbox' : 'textbox';
      }
      case 'SELECT': return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
      case 'TEXTAREA': return 'textbox';
      case 'OPTION': return 'option';
      case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': return 'heading';
      case 'IMG': return el.getAttribute('alt') === '' ? '' : 'img';
      case 'NAV': return 'navigation';
      case 'MAIN': return 'main';
      case 'ASIDE': return 'complementary';
      case 'HEADER': return el.parentElement && el.parentElement.closest(SECTIONING) ? '' : 'banner';
      case 'FOOTER': return el.parentElement && el.parentElement.closest(SECTIONING) ? '' : 'contentinfo';
      case 'FORM': return explicitName(el) ? 'form' : '';
      case 'SECTION': return explicitName(el) ? 'region' : '';
      case 'SEARCH': return 'search';
      case 'ARTICLE': return 'article';
      case 'UL': case 'OL': case 'MENU': return 'list';
      case 'LI': return 'listitem';
      case 'TABLE': return 'table';
      case 'TR': return 'row';
      case 'TD': return 'cell';
      case 'TH': return 'columnheader';
      case 'DIALOG': return 'dialog';
      case 'P': return 'paragraph';
      case 'IFRAME': return 'iframe';
      case 'HR': return 'separator';
      case 'FIELDSET': case 'DETAILS': return 'group';
      case 'FIGURE': return 'figure';
      case 'BLOCKQUOTE': return 'blockquote';
      case 'PROGRESS': return 'progressbar';
      case 'METER': return 'meter';
      default: return '';
    }
  }

  const FOCUSABLE_SEL = 'a[href], button:not([disabled]), input:not([type="hidden"]):not([disabled]), ' +
    'select:not([disabled]), textarea:not([disabled]), summary, iframe, [contenteditable=""], [contenteditable="true"], ' +
    '[tabindex]:not([tabindex^="-"])';

  function computedRole(el) {
    const explicit = (el.getAttribute('role') || '').trim().toLowerCase().split(/\s+/).find(validRole);
    if (explicit && explicit !== 'none' && explicit !== 'presentation' && explicit !== 'generic') return explicit;
    // Focusable elements ignore role="none", as browsers do.
    if (explicit && !el.matches(FOCUSABLE_SEL)) return '';
    if (el.tagName === 'svg' || el instanceof SVGElement) {
      return el.tagName === 'svg' && (el.getAttribute('aria-label') || el.querySelector(':scope > title')) ? 'img' : '';
    }
    return implicitRole(el);
  }

  /** Rendered and in the accessibility tree. display: contents has no box but its children do. */
  function rendered(el) {
    if (typeof el.checkVisibility === 'function') {
      if (el.checkVisibility({ visibilityProperty: true })) return true;
      return getComputedStyle(el).display === 'contents';
    }
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden';
  }

  function stateProps(el, r) {
    const p = [];
    const aria = (n) => el.getAttribute(`aria-${n}`);
    if (r === 'heading') p.push(`level=${/^H[1-6]$/.test(el.tagName) ? el.tagName[1] : Number(aria('level')) || 2}`);
    if (['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio'].includes(r)) {
      const c = el.tagName === 'INPUT' ? (el.indeterminate ? 'mixed' : String(el.checked)) : aria('checked');
      if (c === 'true') p.push('checked'); else if (c === 'mixed') p.push('checked=mixed');
    }
    if (aria('expanded') === 'true' || aria('expanded') === 'false') p.push(`expanded=${aria('expanded')}`);
    if (aria('pressed') === 'true') p.push('pressed');
    if (aria('selected') === 'true') p.push('selected');
    if (el.disabled || aria('disabled') === 'true') p.push('disabled');
    if (el.required || aria('required') === 'true') p.push('required');
    return p.join(', ');
  }

  /**
   * A text snapshot of the accessibility tree, close to what agents built on
   * Playwright or CDP read: landmarks and lists as containers, controls and
   * headings as named leaves, and the text between them.
   */
  function buildAgentView() {
    const nodes = [];
    let chars = 0;
    let truncated = false;
    let visited = 0;
    let unnamed = 0;
    let mainAt = null;
    let h1At = null;
    let pending = '';
    let pendingDepth = 0;

    const add = (n) => {
      n.w = n.role.length + n.name.length + (n.props ? n.props.length + 3 : 0) + n.d * 2 + 6;
      chars += n.w;
      if (n.name.length > 160) n.name = n.name.slice(0, 159) + '…';
      if (nodes.length < VIEW_CAP) nodes.push(n); else truncated = true;
    };
    const flush = () => {
      const t = norm(pending);
      pending = '';
      if (t) add({ d: pendingDepth, role: 'text', name: t });
    };
    const kids = (el) => {
      if (el.shadowRoot) return el.shadowRoot.childNodes;
      if (el.tagName === 'SLOT') {
        const assigned = el.assignedNodes({ flatten: true });
        return assigned.length ? assigned : el.childNodes;
      }
      return el.childNodes;
    };

    const walk = (node, d) => {
      if (visited++ > VIEW_SCAN_CAP) { truncated = true; return; }
      if (node.nodeType === 3) {
        if (!pending.trim()) pendingDepth = d;
        pending += node.data;
        return;
      }
      if (node.nodeType !== 1) return;
      const el = node;
      if (SKIP_TAGS.has(el.tagName) || el.hasAttribute('data-agent-readiness-highlight')) return;
      if (el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('inert')) return;
      if (!rendered(el)) return;
      const r = computedRole(el);
      if (LEAF_ROLES.has(r)) {
        flush();
        const name = r === 'separator' ? '' : accName(el);
        if (r === 'heading' && h1At == null && el.tagName === 'H1') h1At = chars;
        const flag = NEEDS_NAME.has(r) && !name ? 'unnamed' : '';
        if (flag) unnamed++;
        add({ d, role: r, name, props: stateProps(el, r), ref: refs.push(el) - 1, flag });
        return;
      }
      if (CONTAINER_ROLES.has(r)) {
        flush();
        if (r === 'main' && mainAt == null) mainAt = chars;
        const name = explicitName(el);
        const flag = NEEDS_NAME.has(r) && !name ? 'unnamed' : '';
        add({ d, role: r, name, props: r === 'listbox' ? stateProps(el, r) : '', ref: refs.push(el) - 1, flag });
        for (const k of kids(el)) walk(k, d + 1);
        flush();
        return;
      }
      if (el.tagName === 'svg' || el instanceof SVGElement) return;
      pending += ' ';
      for (const k of kids(el)) walk(k, d);
      pending += ' ';
    };

    if (document.body) for (const k of kids(document.body)) walk(k, 0);
    flush();
    return { nodes, chars, tokens: Math.round(chars / 4), truncated, unnamed, mainAt, h1At };
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
    {
      id: 'aria-misuse', category: 'names', weight: 3,
      title: 'ARIA that gives agents wrong information',
      why: 'Agents trust ARIA completely. A focusable element marked aria-hidden, a label that points at a missing id, or an aria-label that doesn’t match the visible text tells the agent something false, and it can’t tell that anything is wrong.',
      fix: 'Remove aria-hidden from anything focusable, point aria-labelledby and aria-describedby at ids that exist, use valid roles and true/false values, and start each aria-label with the control’s visible text.',
      run(ctx) {
        const out = [];
        const seen = new Set();
        const flag = (el, note) => { if (!seen.has(el)) { seen.add(el); out.push({ el, note }); } };

        for (const host of $$('[aria-hidden="true"]')) {
          if (host.closest('[inert]')) continue;
          const els = host.matches(FOCUSABLE_SEL) ? [host] : [];
          els.push(...$$(FOCUSABLE_SEL, host));
          for (const el of els.slice(0, 20)) {
            if (/^\s*-/.test(el.getAttribute('tabindex') || '')) continue; // aria-hidden + tabindex="-1" is correct
            if (visible(el)) flag(el, 'Focusable, but hidden from agents with aria-hidden="true"');
          }
        }
        for (const el of $$('[aria-labelledby], [aria-describedby], [aria-errormessage]')) {
          if (!visible(el)) continue;
          for (const attr of ['aria-labelledby', 'aria-describedby', 'aria-errormessage']) {
            const ids = norm(el.getAttribute(attr)).split(' ').filter(Boolean);
            const missing = ids.filter((id) => !document.getElementById(id));
            if (missing.length) { flag(el, `${attr} points at a missing id: ${missing.slice(0, 2).join(', ')}`); break; }
          }
        }
        for (const el of $$('[role]')) {
          const tokens = norm(el.getAttribute('role')).toLowerCase().split(' ').filter(Boolean);
          if (tokens.length && !tokens.some(validRole) && visible(el)) flag(el, `role="${tokens.join(' ').slice(0, 30)}" isn’t a real ARIA role`);
        }
        for (const el of $$('[role="button"], [role="link"], [role="checkbox"], [role="switch"], [role="tab"]')) {
          if (el.matches(FOCUSABLE_SEL) || el.hasAttribute('tabindex') || el.closest('[aria-activedescendant]')) continue;
          if (visible(el)) flag(el, `role="${role(el)}" but it can’t be reached with the keyboard (add tabindex="0")`);
        }
        const BOOL = { expanded: 'tf', selected: 'tf', disabled: 'tf', required: 'tf', hidden: 'tf', pressed: 'tfm', checked: 'tfm' };
        for (const [attr, kind] of Object.entries(BOOL)) {
          for (const el of $$(`[aria-${attr}]`)) {
            const v = el.getAttribute(`aria-${attr}`).trim().toLowerCase();
            const ok = v === '' || v === 'true' || v === 'false' || v === 'undefined' || (kind === 'tfm' && v === 'mixed');
            if (!ok && visible(el)) flag(el, `aria-${attr}="${v.slice(0, 20)}" isn’t valid (use true or false)`);
          }
        }
        const squash = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
        for (const c of ctx.controls) {
          if (!c.name || !(c.el.hasAttribute('aria-label') || c.el.hasAttribute('aria-labelledby'))) continue;
          const shown = norm(c.el.innerText);
          if (shown.length < 2 || shown.length > 60 || !/\p{L}/u.test(shown)) continue;
          const name = squash(c.name);
          const vis = squash(shown);
          const repeated = name && vis.split(name).every((part) => !part.trim()); // "Sign in Sign in" from text-swap animations
          if (!name.includes(vis) && !repeated) {
            flag(c.el, `Shows “${shown.slice(0, 30)}” but is named “${c.name.slice(0, 40)}”`);
          }
        }

        const n = out.length;
        return {
          score: ratioScore(n, Math.max(ctx.interactive.length, 10), 0.15),
          issues: n,
          summary: n ? `${pl(n, 'element')} ${vb(n, 'has', 'have')} ARIA that misleads agents.` : 'No misleading or broken ARIA found.',
          findings: findings(out, (o) => o.note),
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
      id: 'layout-shifts', category: 'interaction', weight: 1,
      title: 'Layout shifts while loading',
      why: 'Agents read the page, decide where to click, then click. If buttons move in between, because images, ads or banners load late, the click lands on the wrong thing.',
      fix: 'Reserve space for images, ads, embeds and banners with width and height or aspect-ratio, and don’t insert content above what’s already on screen.',
      async run(ctx) {
        const entries = await layoutShifts();
        if (!entries) return { score: null, status: 'na', summary: 'This browser doesn’t report layout shifts.' };
        const shifts = entries.filter((e) => !e.hadRecentInput).sort((a, b) => a.startTime - b.startTime);
        // CLS: the largest burst of shifts (gaps under 1 s, at most 5 s long).
        let cls = 0; let cur = 0; let first = 0; let last = 0;
        for (const e of shifts) {
          if (cur && e.startTime - last < 1000 && e.startTime - first < 5000) cur += e.value;
          else { cur = e.value; first = e.startTime; }
          last = e.startTime;
          cls = Math.max(cls, cur);
        }
        const moved = new Map();
        for (const e of shifts) {
          for (const s of e.sources || []) {
            const el = s.node;
            if (!el || el.nodeType !== 1 || !el.isConnected) continue;
            if (!ctx.interactiveSet.has(el) && !el.querySelector(HAS_CONTROL_SEL)) continue;
            const a = s.previousRect; const b = s.currentRect;
            const dist = Math.hypot(b.x - a.x, b.y - a.y);
            if (dist >= 10) moved.set(el, Math.max(moved.get(el) || 0, dist));
          }
        }
        const list = [...moved].map(([el, dist]) => ({ el, dist })).sort((a, b) => b.dist - a.dist);
        const score = cls <= 0.1 ? 1 : cls <= 0.25 ? 0.75 : cls <= 0.5 ? 0.55 : 0.3;
        const bad = cls > 0.1;
        return {
          score,
          issues: bad ? Math.max(1, list.length) : 0,
          summary: `Layout shift score ${cls.toFixed(2)} since the page loaded (0.1 or less is good).` +
            (bad && list.length ? ` ${pl(list.length, 'control')} moved.` : ''),
          findings: bad ? findings(list, (m) => `Moved ${Math.round(m.dist)} px while the page loaded`) : [],
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
          summary: `${pl(c, 'element')}, nested up to ${ctx.maxDepth} levels deep. As an accessibility snapshot it’s about ${ctx.view.tokens.toLocaleString()} tokens.`,
        };
      },
    },
    {
      id: 'nojs-content', category: 'structure', weight: 2,
      title: 'Content that needs JavaScript',
      why: 'Many agents and AI crawlers fetch a page without running its scripts. Anything added by JavaScript, such as prices, product details or a whole single-page app, is missing for them.',
      fix: 'Render the main content, headings, prices and primary actions on the server (server-side rendering or static generation), and include structured data in the HTML rather than adding it with a tag manager.',
      async run() {
        let r;
        try { r = await fetchRes(pageUrl(), { accept: 'text/html', credentials: 'include', timeout: 8000, max: 4000000 }); } catch {
          return { score: null, status: 'na', summary: 'Couldn’t fetch this page’s HTML to compare.' };
        }
        if (!r.ok || !/html/i.test(r.type)) return { score: null, status: 'na', summary: `Couldn’t compare: the page URL returned ${r.ok ? r.type || 'no content type' : `status ${r.status}`}.` };
        const raw = new DOMParser().parseFromString(r.text, 'text/html');
        const liveText = textOf(document.body, true);
        const rawText = textOf(raw.body, false);
        const liveWords = wordCount(liveText);
        if (liveWords < 40) return { score: null, status: 'na', summary: 'Too little text on this page to compare.' };
        const ratio = Math.min(1, wordCount(rawText) / liveWords);
        const hay = ' ' + squashText(rawText) + ' ';
        const missing = [];
        for (const el of $$('h1, h2, h3').filter(usable)) {
          const t = squashText(el.innerText);
          if (t.length >= 3 && !hay.includes(t)) missing.push({ el, note: `${el.tagName.toLowerCase()} only appears after JavaScript runs` });
        }
        const PRICE = /(?:[$€£¥₹]\s?\d[\d.,]*|\d[\d.,]*\s?(?:USD|EUR|GBP|INR|€))/;
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let prices = 0;
        for (let t = walker.nextNode(); t && prices < 10; t = walker.nextNode()) {
          const m = t.data.match(PRICE);
          if (!m || !t.parentElement || !usable(t.parentElement)) continue;
          if (!hay.includes(squashText(m[0]))) { missing.push({ el: t.parentElement, note: `Price “${m[0].trim()}” only appears after JavaScript runs` }); prices++; }
        }
        const ldRaw = raw.querySelectorAll('script[type="application/ld+json"]').length;
        const ldLive = $$('script[type="application/ld+json"]').length;
        const ldLate = ldLive > ldRaw;
        let score = ratio >= 0.85 ? 1 : clamp01((ratio - 0.15) / 0.7);
        if (missing.some((m) => /^h1/.test(m.note))) score *= 0.8;
        if (missing.length) score = Math.min(score, 0.9);
        if (ldLate) score *= 0.9;
        const parts = [`The HTML the server sends contains ${Math.round(ratio * 100)}% of the text on the rendered page.`];
        if (missing.length) parts.push(`${pl(missing.length, 'heading or price', 'headings and prices')} only ${vb(missing.length, 'appears', 'appear')} after JavaScript runs.`);
        if (ldLate) parts.push(`${pl(ldLive - ldRaw, 'structured data block')} ${vb(ldLive - ldRaw, 'is', 'are')} added by script.`);
        return {
          score,
          issues: (ratio < 0.85 ? 1 : 0) + missing.length + (ldLate ? 1 : 0),
          summary: parts.join(' '),
          findings: findings(missing, (m) => m.note),
        };
      },
    },
    {
      id: 'content-start', category: 'structure', weight: 1,
      title: 'Where the main content starts',
      why: 'Agents read the page from the top and often cut it off to fit their context. If menus, mega-navigation and banners come first, the agent spends its budget on them and may never reach the content.',
      fix: 'Keep the header and navigation lean, put long menus behind a button that expands them, move secondary blocks after <main>, and mark the main content with <main>.',
      run(ctx) {
        const v = ctx.view;
        const start = v.mainAt ?? v.h1At;
        if (start == null) return { score: null, status: 'na', summary: 'No main landmark or h1 to measure from.' };
        const preTok = Math.round(start / 4);
        const share = start / Math.max(1, v.chars);
        let score = preTok <= 1500 ? 1 : preTok <= 4000 ? 0.8 : preTok <= 8000 ? 0.6 : 0.35;
        if (share > 0.5 && preTok > 500) score = Math.min(score, 0.6);
        const blocks = [];
        let at = 0;
        let top = null;
        for (const n of v.nodes) {
          if (at >= start) break;
          if (n.d === 0) { top = { el: refs[n.ref], role: n.role, name: n.name, w: 0 }; if (top.el) blocks.push(top); }
          if (top) top.w += n.w;
          at += n.w;
        }
        const big = blocks.filter((b) => b.el && b.w / 4 >= 300 && b.w >= start * 0.1).sort((a, b) => b.w - a.w).slice(0, 5);
        return {
          score,
          issues: score < 0.95 ? 1 : 0,
          summary: `The main content starts about ${preTok.toLocaleString()} tokens into the page (${Math.round(share * 100)}% of roughly ${v.tokens.toLocaleString()}).`,
          findings: score < 0.95 ? findings(big, (b) => `${b.role === 'text' ? 'Text' : b.role}${b.name ? ` “${b.name.slice(0, 30)}”` : ''}: about ${Math.round(b.w / 4).toLocaleString()} tokens before the main content`) : [],
        };
      },
    },

    // ---- Agent safety
    {
      id: 'hidden-instructions', category: 'safety', weight: 3,
      title: 'Hidden instructions aimed at agents',
      why: 'Text that people can’t see but agents read, such as invisible spans, off-screen blocks, aria-labels or HTML comments saying “ignore previous instructions”, is a prompt injection. Agents may follow it, and agent browsers increasingly warn about or refuse sites that contain it.',
      fix: 'Remove hidden text that addresses AI agents. If you want to guide agents, say it openly: in visible text, in llms.txt, or in structured data.',
      run() {
        const out = [];
        const root = document.body || document.documentElement;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let scanned = 0;
        for (let t = walker.nextNode(); t && scanned < 60000; t = walker.nextNode()) {
          scanned++;
          const el = t.parentElement;
          if (!el || t.data.length < 12 || el.closest('script, style, template, noscript, code, pre, textarea')) continue;
          if (!INJECTION.some((re) => re.test(t.data))) continue;
          const how = hiddenHow(el);
          if (how && !out.some((o) => o.el === el)) out.push({ el, note: `${how}: “${norm(t.data).slice(0, 80)}”` });
        }
        for (const el of $$('[aria-label], [aria-description], [alt], [title]')) {
          for (const attr of ['aria-label', 'aria-description', 'alt', 'title']) {
            const v = el.getAttribute(attr);
            if (v && v.length >= 12 && INJECTION.some((re) => re.test(v))) {
              out.push({ el, note: `In ${attr}, which agents read but people don’t see: “${norm(v).slice(0, 80)}”` });
              break;
            }
          }
        }
        let comments = 0;
        const cw = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_COMMENT);
        for (let c = cw.nextNode(); c && comments < 20; c = cw.nextNode()) {
          if (c.data.length >= 12 && INJECTION.some((re) => re.test(c.data))) {
            comments++;
            out.push({ el: c.parentElement || document.documentElement, note: `HTML comment: “${norm(c.data).slice(0, 80)}”`, comment: true });
          }
        }
        const n = out.length;
        const hard = n - comments;
        return {
          score: countScore(hard, 0.5) * countScore(comments, 0.2),
          issues: n,
          summary: n ? `Found ${pl(n, 'piece', 'pieces')} of hidden text that ${vb(n, 'reads', 'read')} like instructions to an AI agent.` : 'No hidden instructions aimed at agents found.',
          findings: findings(out, (o) => o.note),
        };
      },
    },

    // ---- Shopping agents (scored only on product pages)
    {
      id: 'product-schema', category: 'commerce', weight: 3,
      title: 'Product structured data',
      why: 'AI shopping agents compare products from structured data, not from the layout. Without a Product block they have to guess the name, brand and model from the page text, and often skip the product.',
      fix: 'Add JSON-LD of type Product with name, image, description, brand, and an identifier such as sku, gtin or mpn. Most shop platforms and SEO plugins can output it.',
      run(ctx) {
        const c = commerceInfo(ctx);
        if (!c.isProduct) return { score: null, status: 'na', summary: c.listing ? 'This looks like a product listing, not a single product page.' : 'This doesn’t look like a product page.' };
        if (!c.product) {
          return c.micro
            ? { score: 0.6, issues: 1, summary: 'This product page uses microdata but no JSON-LD Product block, which more agents read.' }
            : { score: 0, issues: 1, summary: 'This looks like a product page, but it has no Product structured data.' };
        }
        const p = c.product;
        const fields = [
          ['name', 1, !!norm(p.name)],
          ['image', 1, !!p.image],
          ['description', 1, !!norm(typeof p.description === 'string' ? p.description : '')],
          ['brand', 0.5, !!p.brand],
          ['an identifier (sku, gtin or mpn)', 0.5, ['sku', 'gtin', 'gtin8', 'gtin12', 'gtin13', 'gtin14', 'mpn', 'productGroupID'].some((k) => p[k])],
        ];
        const missing = fields.filter((f) => !f[2]);
        const score = fields.reduce((a, f) => a + (f[2] ? f[1] : 0), 0) / 4;
        return {
          score,
          issues: missing.length,
          summary: missing.length ? `The Product block is missing ${listJoin(missing.map((f) => f[0]))}.` : `Product “${norm(p.name).slice(0, 60)}” has name, image, description, brand and an identifier.`,
        };
      },
    },
    {
      id: 'product-offer', category: 'commerce', weight: 3,
      title: 'Price and availability for agents',
      why: 'Before an agent recommends or buys a product, it needs the price, the currency and whether it’s in stock. If structured data leaves these out, or shows a different price than the page, agents skip the product or quote the wrong price.',
      fix: 'Add an offers object to the Product with price, priceCurrency and availability (for example https://schema.org/InStock), and keep the price the same as the one shown on the page.',
      run(ctx) {
        const c = commerceInfo(ctx);
        if (!c.isProduct) return { score: null, status: 'na', summary: 'This doesn’t look like a product page.' };
        if (!c.product) return { score: 0, issues: 1, summary: 'No Product structured data, so agents can’t read the price or stock.' };
        const o = c.offer;
        if (!o) return { score: 0.2, issues: 1, summary: 'The Product block has no offers, so agents can’t read the price or stock.' };
        const price = o.price ?? o.lowPrice ?? (o.priceSpecification && o.priceSpecification.price);
        const fields = [['price', price != null && price !== ''], ['priceCurrency', !!(o.priceCurrency || (o.priceSpecification && o.priceSpecification.priceCurrency))], ['availability', !!o.availability]];
        const missing = fields.filter((f) => !f[1]).map((f) => f[0]);
        let mismatch = false;
        if (price != null && price !== '') {
          const n = Number(String(price).replace(/[^\d.]/g, ''));
          const text = (document.body.innerText || '').replace(/\s+/g, ' ');
          const forms = Number.isFinite(n) && n > 0
            ? [n.toFixed(2), n.toFixed(2).replace('.', ','), String(n), n.toLocaleString('en-US', { minimumFractionDigits: 2 }), n.toLocaleString('de-DE', { minimumFractionDigits: 2 })]
            : [];
          if (forms.length && !forms.some((f) => text.includes(f))) mismatch = true;
        }
        const score = clamp01((3 - missing.length) / 3 - (mismatch ? 0.3 : 0));
        const parts = [];
        if (missing.length) parts.push(`The offer is missing ${listJoin(missing)}.`);
        if (mismatch) parts.push(`The structured-data price (${String(price).slice(0, 20)}) doesn’t appear on the page.`);
        return {
          score,
          issues: missing.length + (mismatch ? 1 : 0),
          summary: parts.length ? parts.join(' ') : `Price ${price} ${o.priceCurrency || ''}, ${String(o.availability).replace(/^https?:\/\/schema\.org\//, '')}.`.replace(/\s+,/, ','),
        };
      },
    },
    {
      id: 'purchase-info', category: 'commerce', weight: 2,
      title: 'Shipping, returns and reviews',
      why: 'Shopping agents weigh delivery cost, return terms and ratings when they compare stores. If these are only in the page text or on another page, the agent may not find them at all.',
      fix: 'Add shippingDetails and hasMerchantReturnPolicy to the offer, and aggregateRating (or review) to the Product.',
      run(ctx) {
        const c = commerceInfo(ctx);
        if (!c.isProduct) return { score: null, status: 'na', summary: 'This doesn’t look like a product page.' };
        if (!c.product) return { score: 0, issues: 1, summary: 'No Product structured data, so shipping, returns and reviews can’t be read.' };
        const o = c.offer || {};
        const fields = [
          ['shipping details', !!(o.shippingDetails || c.product.shippingDetails)],
          ['a return policy', !!(o.hasMerchantReturnPolicy || c.product.hasMerchantReturnPolicy || c.nodes.some((n) => typeIs(n, 'MerchantReturnPolicy')))],
          ['ratings or reviews', !!(c.product.aggregateRating || c.product.review)],
        ];
        const missing = fields.filter((f) => !f[1]).map((f) => f[0]);
        return {
          score: (3 - missing.length) / 3,
          issues: missing.length,
          summary: missing.length ? `Structured data has no ${listJoin(missing, 'or')}.` : 'Shipping, return policy and ratings are all in structured data.',
        };
      },
    },
    {
      id: 'cart-button', category: 'commerce', weight: 2,
      title: 'A clear “Add to cart” button',
      why: 'To buy, an agent looks for a button named like “Add to cart”. If the button is a styled div, an icon without a name, or uses wording agents don’t expect, the purchase stalls.',
      fix: 'Use a real <button> with visible text such as “Add to cart”, “Add to bag” or “Buy now”. If it’s an icon, add an aria-label.',
      run(ctx) {
        const c = commerceInfo(ctx);
        if (!c.isProduct && !c.cart.length && !c.fakeCart.length) return { score: null, status: 'na', summary: 'No product or cart controls on this page.' };
        if (c.fakeCart.length && !c.cart.length) {
          return {
            score: 0.2, issues: c.fakeCart.length,
            summary: `The “add to cart” control isn’t a real button, so agents may not find it.`,
            findings: findings(c.fakeCart, () => 'Looks like an add-to-cart button, but has no button role'),
          };
        }
        if (!c.cart.length) return { score: 0.75, issues: 1, summary: 'No button named like “Add to cart” or “Buy now” found. If it only appears after choosing a size or color, make sure its name says what it does.' };
        const names = [...new Set(c.cart.map((x) => x.name))].slice(0, 3).map((n) => `“${n.slice(0, 30)}”`);
        return {
          score: c.fakeCart.length ? 0.8 : 1,
          issues: c.fakeCart.length,
          summary: `Found ${pl(c.cart.length, 'cart button')}: ${names.join(', ')}.` + (c.fakeCart.length ? ` ${pl(c.fakeCart.length, 'other one isn’t', 'others aren’t')} a real button.` : ''),
          findings: findings(c.fakeCart, () => 'Looks like an add-to-cart button, but has no button role'),
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

    // ---- Agent protocols (informational, not scored)
    {
      id: 'markdown-negotiation', category: 'protocols', weight: 0, info: true,
      title: 'Markdown version for agents',
      why: 'Some agents ask for a page with Accept: text/markdown. Serving Markdown saves them the tokens spent on markup, scripts and navigation.',
      fix: 'Return a Markdown rendering when a request sends Accept: text/markdown (and send Vary: Accept), or link one with <link rel="alternate" type="text/markdown" href="…">.',
      async run() {
        const alt = document.querySelector('link[rel~="alternate" i][type="text/markdown" i], link[rel~="alternate" i][type="text/x-markdown" i]');
        let negotiated = false;
        try {
          const r = await fetchRes(pageUrl(), { accept: 'text/markdown' });
          negotiated = r.ok && /text\/(x-)?markdown/i.test(r.type);
        } catch { /* treat as not offered */ }
        if (!negotiated && !alt) return { score: null, status: 'info', issues: 0, summary: 'The page doesn’t answer Accept: text/markdown and doesn’t link a Markdown version.' };
        const parts = [];
        if (negotiated) parts.push('Returns Markdown for Accept: text/markdown.');
        if (alt) parts.push(`Links a Markdown version: ${alt.getAttribute('href')}.`);
        return { score: null, status: 'pass', issues: 0, summary: parts.join(' ') };
      },
    },
    {
      id: 'discovery-links', category: 'protocols', weight: 0, info: true,
      title: 'Sitemap and Link headers',
      why: 'A sitemap lists the pages an agent can visit. Link response headers (RFC 8288) can point an agent straight to an API catalog, documentation or a Markdown version.',
      fix: 'Publish /sitemap.xml and reference it from robots.txt with a Sitemap: line. If you have an API or docs, add Link headers such as rel="api-catalog" or rel="service-doc".',
      async run() {
        let sitemap = '';
        try {
          const robots = await fetchText('/robots.txt');
          const m = robots.found && robots.text.match(/^\s*sitemap\s*:\s*(\S+)/im);
          if (m) sitemap = `${m[1]} (from robots.txt)`;
        } catch { /* ignore */ }
        if (!sitemap) {
          try {
            const r = await fetchRes(location.origin + '/sitemap.xml');
            if (r.ok && /<(urlset|sitemapindex)\b/i.test(r.text.slice(0, 2000))) sitemap = `${location.origin}/sitemap.xml`;
          } catch { /* ignore */ }
        }
        let rels = [];
        try {
          const r = await fetchRes(pageUrl(), { accept: 'text/html', credentials: 'include', timeout: 8000, max: 4000000 });
          rels = [...r.link.matchAll(/rel\s*=\s*"?([^";,]+)"?/gi)].flatMap((m) => m[1].trim().split(/\s+/));
          rels = [...new Set(rels.filter((x) => !/^(preload|preconnect|dns-prefetch|modulepreload|prefetch|stylesheet)$/i.test(x)))];
        } catch { /* ignore */ }
        const parts = [sitemap ? `Sitemap: ${sitemap}.` : 'No sitemap found.'];
        parts.push(rels.length ? `Link header relations: ${rels.slice(0, 6).join(', ')}.` : 'No Link headers for agents.');
        return { score: null, status: sitemap ? 'pass' : 'info', issues: 0, summary: parts.join(' ') };
      },
    },
    {
      id: 'mcp-discovery', category: 'protocols', weight: 0, info: true,
      title: 'MCP server card',
      why: 'An MCP server card at /.well-known/mcp/server-card.json tells agents the site offers tools over the Model Context Protocol, and how to connect and sign in. It’s a draft with very little adoption so far.',
      fix: 'If you run an MCP server, publish its card at /.well-known/mcp/server-card.json with its name, transport URL and authentication details.',
      async run() {
        const paths = ['/.well-known/mcp/server-card.json', '/.well-known/mcp.json'];
        const got = await Promise.all(paths.map(fetchJson));
        const i = got.findIndex((g) => g && g.data);
        if (i >= 0) {
          const d = got[i].data;
          const name = (d.serverInfo && d.serverInfo.name) || d.name || d.title || '';
          return { score: null, status: 'pass', issues: 0, summary: `Found ${paths[i]}${name ? ` for “${String(name).slice(0, 60)}”` : ''}.` };
        }
        const bad = got.findIndex((g) => g && g.invalid);
        if (bad >= 0) return { score: null, status: 'warn', issues: 1, summary: `${paths[bad]} exists but isn’t valid JSON.` };
        return { score: null, status: 'info', issues: 0, summary: 'No MCP server card found.' };
      },
    },
    {
      id: 'api-discovery', category: 'protocols', weight: 0, info: true,
      title: 'API, sign-in and skills discovery',
      why: 'Sites with an API or accounts can tell agents where things are: an API catalog (RFC 9727), OAuth metadata (RFC 8414 and RFC 9728) so agents can ask for access instead of borrowing a person’s session, and an Agent Skills index.',
      fix: 'If you offer an API, publish /.well-known/api-catalog. If agents should sign in, publish OAuth authorization-server and protected-resource metadata. Content-only sites can skip this.',
      async run() {
        const items = [
          ['API catalog', '/.well-known/api-catalog'],
          ['OAuth server metadata', '/.well-known/oauth-authorization-server'],
          ['OpenID configuration', '/.well-known/openid-configuration'],
          ['OAuth protected-resource metadata', '/.well-known/oauth-protected-resource'],
          ['Agent Skills index', '/.well-known/agent-skills/index.json'],
        ];
        const got = await Promise.all(items.map(([, p]) => fetchJson(p)));
        const found = items.filter((_, i) => got[i] && got[i].data).map(([label]) => label);
        const invalid = items.filter((_, i) => got[i] && got[i].invalid).map(([, p]) => p);
        const parts = [found.length ? `Found: ${found.join(', ')}.` : 'No API catalog, OAuth metadata or Agent Skills index found.'];
        if (invalid.length) parts.push(`Not valid JSON: ${invalid.join(', ')}.`);
        return { score: null, status: invalid.length ? 'warn' : found.length ? 'pass' : 'info', issues: invalid.length, summary: parts.join(' ') };
      },
    },
    {
      id: 'content-signals', category: 'protocols', weight: 0, info: true,
      title: 'Content Signals in robots.txt',
      why: 'Content Signals let a site say separately whether its content may be used for search, for AI answers (ai-input) and for AI training (ai-train), instead of blocking crawlers outright.',
      fix: 'Add a line such as Content-Signal: search=yes, ai-input=yes, ai-train=no to robots.txt.',
      async run() {
        let r;
        try { r = await fetchText('/robots.txt'); } catch {
          return { score: null, status: 'na', summary: 'Couldn’t read robots.txt from this page.' };
        }
        const lines = r.found ? [...r.text.matchAll(/^\s*content-signal\s*:\s*(.+)$/gim)].map((m) => m[1].trim()) : [];
        if (!lines.length) return { score: null, status: 'info', issues: 0, summary: r.found ? 'robots.txt has no Content-Signal lines.' : 'No robots.txt found.' };
        return { score: null, status: 'pass', issues: 0, summary: `Content-Signal: ${lines[0].slice(0, 100)}${lines.length > 1 ? ` (and ${lines.length - 1} more)` : ''}.` };
      },
    },
    {
      id: 'webmcp', category: 'protocols', weight: 0, info: true,
      title: 'WebMCP tools',
      why: 'WebMCP lets a page offer agents named tools, like “search_flights”, instead of making them click through the interface. It’s an origin trial in Chrome with almost no adoption yet, so it’s optional.',
      fix: 'Add toolname and tooldescription to key forms, give every field a name and a label, or register tools in script with the registerTool() method of document.modelContext.',
      run(ctx) {
        const probe = ctx.probe || {};
        const tools = Array.isArray(probe.tools) ? probe.tools : [];
        const forms = $$('form[toolname]');
        const problems = [];
        for (const f of forms) {
          const name = norm(f.getAttribute('toolname'));
          if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) problems.push({ el: f, note: `toolname “${name.slice(0, 40)}” should be 1–64 letters, digits, _ . or -` });
          if (!norm(f.getAttribute('tooldescription'))) problems.push({ el: f, note: `Tool “${name.slice(0, 40)}” has no tooldescription` });
          for (const field of $$('input, select, textarea', f)) {
            const type = (field.getAttribute('type') || '').toLowerCase();
            if (['hidden', 'submit', 'button', 'reset', 'image'].includes(type)) continue;
            if (!field.getAttribute('name')) problems.push({ el: field, note: 'No name attribute, so it can’t become a tool parameter' });
            else if (!accName(field) && !norm(field.getAttribute('toolparamdescription'))) problems.push({ el: field, note: 'No label or toolparamdescription' });
          }
        }
        const undescribed = tools.filter((t) => !norm(t.description)).map((t) => t.name);
        const scriptHint = !tools.length && !forms.length &&
          $$('script:not([src])').some((s) => /modelContext\s*\.\s*(registerTool|provideContext)\s*\(/.test(s.textContent.slice(0, 500000)));
        if (!forms.length && !tools.length && !scriptHint) {
          return { score: null, status: 'info', issues: 0, summary: probe.supported ? 'No WebMCP tools found. This browser supports WebMCP.' : 'No WebMCP tools found.' };
        }
        const parts = [];
        if (tools.length) parts.push(`Registered tools: ${tools.slice(0, 8).map((t) => t.name).join(', ')}.`);
        if (forms.length) parts.push(`${pl(forms.length, 'form')} declared as ${vb(forms.length, 'a tool', 'tools')}: ${forms.slice(0, 6).map((f) => f.getAttribute('toolname')).join(', ')}.`);
        if (scriptHint) parts.push('Inline scripts appear to register WebMCP tools, but this browser couldn’t list them.');
        if (undescribed.length) parts.push(`No description: ${undescribed.slice(0, 5).join(', ')}.`);
        if (problems.length) parts.push(`${pl(problems.length, 'problem')} with declared tools.`);
        const issues = problems.length + undescribed.length;
        return { score: null, status: issues ? 'warn' : 'pass', issues, summary: parts.join(' '), findings: findings(problems, (p) => p.note) };
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

  async function run(opts = {}) {
    const started = performance.now();
    refs.length = 0;
    fetchCache.clear();
    const runId = Math.random().toString(36).slice(2, 10);
    window.__ARA.runId = runId;

    const ctx = gather();
    ctx.view = buildAgentView();
    ctx.probe = opts.probe || null;

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
      return { id: cat.id, name: cat.name, description: cat.description, weight: cat.weight, scored: cat.scored !== false, score, checks: own };
    });

    const scoredCats = categories.filter((c) => c.score != null && c.scored);
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
        tokens: ctx.view.tokens,
      },
      categories,
      agentView: {
        nodes: ctx.view.nodes.map(({ w, ...n }) => n),
        tokens: ctx.view.tokens,
        unnamed: ctx.view.unnamed,
        truncated: ctx.view.truncated,
      },
    };
  }

  window.__ARA = { version: VERSION, run, refs, runId: null };
})();
