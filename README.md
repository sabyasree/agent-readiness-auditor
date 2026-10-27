# Agent-Readiness Auditor

A Chrome extension that audits any web page for how well AI agents (Claude in Chrome, Gemini in Chrome, ChatGPT agent, Perplexity Comet and others) can read and operate it. It gives a 0–100 score, a breakdown by category, and specific fixes, with a **Show on page** button that scrolls to and highlights each problem element.

Everything runs locally in the browser. No accounts, no servers, no analytics.

## Install for development

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose this folder (the one containing `manifest.json`).
4. Pin the extension, open any website, and click its icon (or press **Alt+Shift+A**). The side panel opens.
5. Press **Run audit**.

Requires Chrome 116 or later (side panel API).

## What it checks

| Category | Weight | Checks |
| --- | --- | --- |
| Real controls | 20 | Clickable divs and spans with no control role, links with no real destination, positive tabindex |
| Labels and names | 20 | Controls with no accessible name, vague or duplicated names, images without alt |
| Forms | 15 | Unlabeled or placeholder-only fields, missing input types and autocomplete tokens, required fields not marked required |
| Interaction traps | 15 | Overlays and cookie banners covering the page, unnamed dialogs, CAPTCHAs and bot challenges, cross-origin iframes, tiny click targets, shadow DOM (informational) |
| Stable targeting | 12 | Controls reachable only through generated class names, auto-generated IDs |
| Page structure | 12 | Page title, `lang`, main and nav landmarks, heading outline, DOM size and depth |
| Machine-readable signals | 6 | Meta description, Open Graph and canonical, JSON-LD and microdata, `/llms.txt`, `robots.txt` rules for AI user agents and crawlers |

### Scoring

Each check produces a score from 0 to 100, mostly from the share of affected elements, so a large page with a few problems isn't punished like a small page full of them. Check scores are weighted into category scores, and category scores are weighted into the overall score. Checks that don't apply (for example, form checks on a page with no forms) are left out rather than counted as passes.

Status per check: 95 and above passes, 70–94 is a warning, below 70 is failing. Any check that finds at least one issue is at least a warning.

Overall grade: 90+ Agent-ready, 75–89 Mostly ready, 50–74 Needs work, below 50 Hard for agents.

The checks are heuristics. They find likely problems quickly; confirming with a real agent run is still the final test.

## Permissions

| Permission | Why |
| --- | --- |
| `activeTab` | Clicking the toolbar icon grants one-time access to the current page, which is all a single audit needs. |
| `scripting` | Injects the audit engine into the page and runs the element highlighter. |
| `sidePanel` | Shows the results in Chrome's side panel. |
| `storage` | Keeps the latest report for each tab in session storage so it survives closing and reopening the panel. Cleared when the tab navigates or closes. |
| `<all_urls>` (optional) | Only requested if the person clicks **Allow on all sites**, so audits work without clicking the toolbar icon first. Not granted at install. |

No host permissions are requested at install, which keeps the Chrome Web Store warning to a minimum and speeds up review.

## Project layout

```
manifest.json          MV3 manifest
background.js          Opens the side panel on icon click; clears stale reports
content/auditor.js     Audit engine. Injected on demand; returns a JSON report
sidepanel/panel.html   Side panel markup
sidepanel/panel.css    Styles, light and dark themes
sidepanel/panel.js     UI: running audits, rendering, highlighting, export
icons/                 16, 32, 48 and 128 px icons
PRIVACY.md             Privacy policy text for the Web Store listing
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
      summary: `${bad.length} things are wrong.`,
      findings: findings(bad, () => 'Note shown under the element'),
    };
  },
},
```

`ctx` holds the visible controls and fields (each with its computed accessible name), fixed-position elements, shadow hosts, element count and DOM depth. `run` may be `async`.

## Publishing to the Chrome Web Store

1. Bump `version` in `manifest.json`.
2. Zip the contents of this folder (not the folder itself): `zip -r agent-readiness-auditor.zip . -x '*.DS_Store'`.
3. In the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole), create a new item and upload the zip.
4. Listing assets you'll need: at least one 1280×800 screenshot of the side panel next to a page, a 440×280 small promo tile, and the 128 px icon from `icons/`.
5. Privacy tab: single purpose is "Audit web pages for AI-agent usability". Justify each permission using the table above. Declare that no user data is collected, and link to a hosted copy of `PRIVACY.md`.

## Known limits

- Audits the top frame only. Content inside iframes and shadow roots is reported but not checked.
- Hover-only menus, infinite scroll and drag-and-drop can't be detected reliably from a static scan, so they aren't scored.
- `llms.txt` and `robots.txt` are fetched from the page's own origin. If the site blocks those requests, the checks are marked not applicable.

## Ideas for the paid tier

Multi-page site crawls, score history per URL, PDF reports for agencies, an LLM-driven "agent test run" that attempts a task on the page and reports where it got stuck, and a CI action that fails builds when readiness drops.
