# Agent-Readiness Auditor

A Chrome extension that audits any web page for how well AI agents (Claude in Chrome, Gemini in Chrome, ChatGPT agent, Perplexity Comet and others) can read and operate it. It gives a 0–100 score, a breakdown by category, and specific fixes, with a **Show on page** button that scrolls to and highlights each problem element.

Most "agent-ready" tools only check whether crawler files like robots.txt and llms.txt exist. This one asks whether an agent can actually *use* the page: find its controls by name, fill its forms, get past overlays, and read the content without being misled. Newer protocol files are shown too, but kept out of the score.

Features:

- **Weekly re-scan with alerts.** After a site scan, turn on **Re-scan every week**: the background worker audits the same pages again each week and, if notifications are allowed, alerts you when the average drops by 3 points or more, or a new problem shows up on most pages.
- **Keyboard and focus.** Controls the Tab key skips (`tabindex="-1"` outside widgets that manage focus) and controls with no visible focus indicator.
- **Shadow DOM and frames.** Controls and fields inside open shadow roots and same-site iframes are audited along with the rest of the page.
- **Name suggestions from on-device AI.** For an unnamed button, link or image, **Suggest a name** asks Chrome's built-in model for a name based on the text, headings, classes and file names around it. Shown only where the model is available.
- **Command line and MCP server.** The same engine as an npm package (`cli/`): audit pages from the terminal, gate CI on a minimum score, or let coding agents audit pages through MCP.
- **Six languages.** English, Spanish, German, Japanese, Portuguese (Brazil) and Bengali, following Chrome's language.
- **Site scan.** Audit up to 25 pages of a site (from its sitemap or the links on the page) in a background tab and see which problems repeat across pages, so you can fix the shared template once. Export a site report or CSV, or copy one fix prompt for the shared problems.
- **Suggested code fixes.** Each problem element comes with corrected code to copy: a real `<button>` instead of a clickable div, a `<label>` for a field, an `aria-label` with a name guessed from the page (icon class names, titles, image file names, link paths), and so on. Guessed names are marked for checking.
- **Compare.** Put this page side by side with any other page you've audited, such as a competitor's: overall and category scores, and the checks where each one does better.
- **Re-run on reload.** While you edit your site, the audit runs again every time the page reloads.
- **Agent test.** Type a task such as "Add this product to the cart". Chrome's built-in AI (Gemini Nano, running on your device) reads the page the way agents do and plans the clicks; the panel shows the plan on the page and where an agent would get stuck, including controls people can see but agents can't. Without the on-device model, it matches the task to control names.
- **Fix these first.** The three fixes worth the most points, with the score you'd reach, and one prompt that covers them.
- **Mark issues on page.** Numbered markers on every problem element at once; hover a number for details.
- **Shareable report.** A clean, standalone HTML report for a client or teammate that prints to PDF.
- **Shopping agents.** On product pages: Product structured data, price and stock, shipping, returns and ratings, and a clear "Add to cart" button.
- **Score on the icon.** After an audit, the toolbar icon shows the page's score.
- **Agent view.** The page as an agent reads it: its accessibility tree as text, with a token estimate. Controls with no name are flagged, every line can be found on the page, and the whole snapshot can be copied.
- **Changes since the last audit.** Re-run after a fix to see the score change and which checks were fixed, are new, or have fewer or more issues.
- **Prompts for coding agents.** Copy the whole report, or one check, as a task for Claude Code, Cursor or Copilot, with a fix → test → verify loop.

Everything runs locally in the browser. No accounts, no servers, no analytics.

### Panel layout

A tab bar under the header stays in view and holds everything after an audit:

- **Overview:** the score, Fix these first, tools (Mark issues, Share report, Compare, Re-run on reload), scores by category, and links to the other tabs.
- **Issues:** every check with why it matters, how to fix it, the affected elements and suggested code. The badge shows the number of failing and warning checks.
- **Agent view**, **Agent test** and **Site scan**, described below. The Agent view badge counts controls with no name.

Before the first audit, the start screen lists what you'll get, recent audits and a link to the demo store.

## Install for development

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose this folder (the one containing `manifest.json`).
4. Pin the extension, open any website, and click its icon (or press **Alt+Shift+A**). The side panel opens and the audit starts.

On first install the extension opens a welcome tab (`welcome/welcome.html`) with a link to the demo store at `site/demo/`, a product page with problems planted on purpose.

Requires Chrome 116 or later (side panel API).

## What it checks

| Category | Weight | Checks |
| --- | --- | --- |
| Real controls | 20 | Clickable divs and spans with no control role, links with no real destination, controls the Tab key skips, no visible focus indicator, positive tabindex |
| Labels and names | 20 | Controls with no accessible name, vague or duplicated names, images without alt, misleading ARIA (focusable elements under `aria-hidden`, references to missing ids, invalid roles and values, keyboard-unreachable ARIA controls, `aria-label` that doesn't contain the visible text) |
| Forms | 15 | Unlabeled or placeholder-only fields, missing input types and autocomplete tokens, required fields not marked required |
| Interaction traps | 15 | Overlays and cookie banners covering the page, unnamed dialogs, CAPTCHAs and bot challenges, cross-origin iframes, tiny click targets, layout shifts that move controls while loading, open shadow DOM and same-site frames (informational; their controls are checked by the other checks) |
| Stable targeting | 12 | Controls reachable only through generated class names, auto-generated IDs |
| Page structure | 12 | Page title, `lang`, main and nav landmarks, heading outline, DOM size and depth, text, headings and prices that only appear after JavaScript runs, how far into the page the main content starts |
| Shopping agents | 10, product pages only | Product structured data (name, image, description, brand, identifier), offer price, currency and availability (and whether the price matches the page), shipping details, return policy and ratings, a real, clearly named "Add to cart" button |
| Agent safety | 6 | Hidden text that reads like instructions to an AI agent (prompt injection): invisible, off-screen, tiny or same-color text, `aria-label`, `alt` and `title` attributes, HTML comments |
| Machine-readable signals | 6 | Meta description, Open Graph and canonical, JSON-LD and microdata, `/llms.txt`, `robots.txt` rules for AI user agents and crawlers |
| Agent protocols | not scored | Markdown for `Accept: text/markdown`, sitemap and `Link` headers, MCP server card, API catalog, OAuth metadata and Agent Skills index, Content Signals, WebMCP tools (declarative `toolname` forms and registered tools) |

Agent protocols are shown for information only. Few sites publish them and few agents read them yet, so a site isn't marked down for skipping them. Their checks show **Passed** when found and **Note** when not, and **Warning** only when something is published but broken.

### Scoring

Each check produces a score from 0 to 100, mostly from the share of affected elements, so a large page with a few problems isn't punished like a small page full of them. Check scores are weighted into category scores, and category scores are weighted into the overall score. Checks that don't apply (for example, form checks on a page with no forms) are left out rather than counted as passes.

Status per check: 95 and above passes, 70–94 is a warning, below 70 is failing. Any check that finds at least one issue is at least a warning.

Overall grade: 90+ Agent-ready, 75–89 Mostly ready, 50–74 Needs work, below 50 Hard for agents.

## Agent test

The **Agent test** tab takes a task in plain words. It lists the page's interactive elements as an agent sees them (role, accessible name, state and the heading above each) and asks Chrome's built-in model, Gemini Nano, through the [Prompt API](https://developer.chrome.com/docs/ai/prompt-api), for a plan constrained to a JSON schema. The plan is then checked: steps must point at real, named controls, and anything the task mentions that people can click but agents can't (from the clickable-div and cart-button checks) is reported. **Show steps on page** marks each step in order. Nothing on the page is clicked.

The model runs on the device and needs Chrome's hardware requirements (about 22 GB free disk, and a GPU with more than 4 GB of VRAM or 16 GB of RAM). Chrome downloads it once, on the first test. Where it isn't available, the test falls back to matching the task's words, with common synonyms, to control names.

## Agent view

The **Agent view** tab lists the page the way agents built on Playwright or the Chrome DevTools Protocol read it: landmarks, lists and tables as containers; links, buttons, fields and headings as named items with their state (`level=1`, `checked`, `expanded=false`, `disabled`); and the text in between. Filter to controls or to controls with no name, search by name or role, select a line to highlight it on the page, or **Copy as text** for an indented snapshot in the style of a Playwright ARIA snapshot. The token count is an estimate (characters ÷ 4).

## Translations

The interface follows Chrome's language. `t('Run audit')` looks up the English text (by a short hash) in `_locales/<lang>/messages.json` and falls back to English. Check titles, descriptions and summaries are translated in the panel; the Markdown, JSON and prompt exports, the shareable report and the CLI stay in English, since they're usually pasted into coding agents or sent to others.

To add or change a translation, edit `scripts/locales/<lang>.json` (English → translation) and run `python3 scripts/build-locales.py`. `--check` lists strings that have no translation yet. A new language needs a new file there, with `extName` and `extDescription` under `_meta` for the store.

## Export

**Share report** opens a standalone HTML report in a new tab (Print → Save as PDF makes a PDF), and **Export → Download shareable report** saves it. The **Export** menu also copies or downloads the report as Markdown or JSON. **Copy report as prompt** copies the failing and warning checks as a task for a coding agent (Claude Code, Cursor, Copilot and others): a goal, a checklist, and a locate → fix → test → verify loop the agent repeats until every issue is fixed and covered by a test. Paste it into the agent running in the site's repository. Each failing check also has its own **Copy fix prompt** button.

Each audit remembers a short summary of the last result for that URL (score and per-check status, no page content) in local storage, so the next audit can show what changed. **Export → Clear audit history** deletes it.

The checks are heuristics. They find likely problems quickly; confirming with a real agent run is still the final test.

## Permissions

| Permission | Why |
| --- | --- |
| `activeTab` | Clicking the toolbar icon grants one-time access to the current page, which is all a single audit needs. |
| `scripting` | Injects the audit engine into the page, draws highlights and issue markers, and lists WebMCP tools the page has registered. |
| `sidePanel` | Shows the results in Chrome's side panel. |
| `storage` | Keeps the latest report for each tab in session storage so it survives closing and reopening the panel (cleared when the tab navigates or closes); in local storage, a short score summary per URL to show changes between audits, and usage counters for the review prompt and "What's new". |
| `alarms` | Wakes the background worker every few hours to run any weekly re-scans that are due. Does nothing unless a re-scan is turned on. |
| `notifications` (optional) | Requested when the person turns on a weekly re-scan, to alert them when the site gets worse. |
| `<all_urls>` (optional) | Never granted at install. Requested for one site at a time when the person starts a **Site scan** or turns on **Re-run on reload** (both need to reach the site again after the one-time access ends), or for all sites if they click **Allow on all sites**. |

No host permissions are requested at install, which keeps the Chrome Web Store warning to a minimum and speeds up review.

## Project layout

```
manifest.json          MV3 manifest
background.js          Opens the side panel on icon click; welcome tab on install; uninstall survey URL; clears stale reports and badges; weekly re-scans and alerts
content/auditor.js     Audit engine. Injected on demand; returns a JSON report
sidepanel/panel.html   Side panel markup
sidepanel/panel.css    Styles, light and dark themes
sidepanel/panel.js     UI: running audits, rendering, highlighting, history, export
sidepanel/scoring.js   Projected score gains for "Fix these first"
sidepanel/overlay.js   Issue and step markers drawn on the page
sidepanel/report-html.js  Standalone shareable HTML report
sidepanel/agent-test.js   Agent test: on-device AI plan, name-matching fallback, evaluation
sidepanel/site-scan.js    Site scan UI: options, progress, shared problems, site report, CSV and the weekly re-scan tile
sidepanel/ai-name.js      "Suggest a name": on-device AI names for unnamed controls in suggested fixes
sidepanel/i18n.js         t(): translations keyed by the English text
lib/scan-core.js          Site scan engine shared by the panel, the background worker and the CLI
_locales/              Generated translations; edit scripts/locales/<lang>.json and run scripts/build-locales.py
welcome/               Welcome tab shown on first install
icons/                 16, 32, 48 and 128 px icons
PRIVACY.md             Privacy policy text for the Web Store listing
cli/                   npm package "agent-readiness-audit": command line, CI score gate and MCP server; not part of the extension zip
netlify.toml           Netlify settings: publishes site/ only
store/                 Chrome Web Store description and 1280×800 screenshots; not part of the extension zip
site/                  Static website deployed to Netlify: homepage, privacy policy, demo store (demo/), uninstall survey (goodbye.html, a Netlify form); not part of the extension zip
```

The engine (`content/auditor.js`) has no dependencies and exposes `window.__ARA.run()`, which returns a plain JSON report. That makes it easy to reuse later in a CLI, a crawler or a CI step (for example with Playwright: inject the file, call `window.__ARA.run()`, fail the build below a threshold).

### Adding a check

Add an object to the `CHECKS` array in `content/auditor.js`:

```js
{
  id: 'my-check', category: 'names', weight: 2,
  title: 'Short name of the problem',
  why: 'One or two sentences on why this matters to agents.',
  fix: 'What to change.',
  run(ctx) {
    const bad = ctx.controls.filter((c) => /* ... */ false);
    return {
      score: ratioScore(bad.length, ctx.controls.length, 0.3), // 0..1, or null if not applicable
      issues: bad.length,
      summary: bad.length ? sayN(bad.length, '$1 thing is wrong.', '$1 things are wrong.') : 'Nothing is wrong.',
      findings: findings(bad, () => 'Note shown under the element'),
    };
  },
},
```

Write summaries with `say('… $1 …', value)` or `sayN(count, singular, plural)` so the panel can translate them, then add the new strings to `scripts/locales/*.json` (`python3 scripts/build-locales.py --check` lists what's missing).

`ctx` holds the visible controls and fields (each with its computed accessible name), fixed-position elements, shadow hosts, element count and DOM depth. `run` may be `async`.

## Publishing to the Chrome Web Store

1. Bump `version` in `manifest.json`.
2. Zip the contents of this folder (not the folder itself), leaving out the website files: `zip -r agent-readiness-auditor.zip . -x '*.DS_Store' -x '.git/*' -x 'site/*' -x netlify.toml -x 'store/*' -x 'cli/*' -x 'scripts/*'`.
3. In the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole), create a new item and upload the zip.
4. Listing assets you'll need: at least one 1280×800 screenshot of the side panel next to a page, a 440×280 small promo tile, and the 128 px icon from `icons/`.
5. Netlify: under **Forms**, turn on form detection so the uninstall survey (`site/goodbye.html`) collects responses.
6. Privacy tab: single purpose is "Audit web pages for AI-agent usability". Justify each permission using the table above. Declare that no user data is collected, and link to the hosted privacy policy (`site/privacy-policy.html`, deployed to Netlify).

## Publishing the command-line tool to npm

The `cli/` folder is published to npm as [`agent-readiness-audit`](https://www.npmjs.com/package/agent-readiness-audit) by the **Publish CLI to npm** workflow (`.github/workflows/publish-cli.yml`). It needs an npm access token saved as the repository secret `NPM_TOKEN`. To release a new version, raise `version` in `cli/package.json`, merge, and run the workflow from the **Actions** tab. It runs the smoke tests first and skips versions that are already on npm.

## Known limits

- Cross-origin iframes and closed shadow roots can't be read; they're reported but not checked. Open shadow roots and same-site frames are checked.
- Hover-only menus, infinite scroll and drag-and-drop can't be detected reliably from a static scan, so they aren't scored.
- `llms.txt`, `robots.txt`, `sitemap.xml` and the `/.well-known/` files are fetched from the page's own origin. If the site blocks those requests, the checks are marked not applicable or not found.
- The JavaScript check fetches the page URL again with your cookies and compares it to the rendered page, so it compares like with like on signed-in pages. Pages that answer differently on a second request (for example, one-time links) can give odd results.
- Layout shifts are read from the browser's record since the page loaded. Shifts caused by your own clicks or typing are ignored.
- Registered WebMCP tools can only be listed in browsers that expose Chrome's WebMCP testing API. Elsewhere the check looks for declarative `toolname` forms and inline scripts that register tools.
- The Agent test plans from the accessibility tree only, like most agents. It doesn't click anything, so it can't catch problems that appear mid-flow (a size picker that opens a dialog, a login wall). Small on-device models also make mistakes; treat a result as a quick check.
- Hidden-instruction detection matches common prompt-injection wording. It can miss reworded or encoded injections, and it doesn't flag visible text, such as an article about prompt injection.

## Ideas for the paid tier

Scans beyond 25 pages, flow audits across several pages (a checkout, a sign-up), white-label reports for agencies, an agent test that actually performs the task in a sandboxed tab, and a hosted dashboard for re-scan history across many sites.
