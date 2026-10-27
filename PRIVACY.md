# Privacy policy: Agent-Readiness Auditor

Last updated: October 28, 2026

Agent-Readiness Auditor analyzes the web page you choose to audit and shows the results in Chrome's side panel.

**What it reads.** When you run an audit, the extension reads the structure of the current page (its elements, attributes and visible text) inside your browser. It also makes a few requests to the same website, the way any visitor's browser could: the page's own URL again (once as a normal page, with your existing cookies, to compare it with what scripts render, and once asking for a Markdown version), and `/llms.txt`, `/robots.txt`, `/sitemap.xml` and a few standard discovery files under `/.well-known/`. These requests go only to the website you are auditing.

**Agent test.** If you run an Agent test, the names and roles of the page's buttons, links and fields, the page title and the task you type are given to Chrome's built-in AI model (Gemini Nano), which runs on your computer. Chrome may download that model the first time. Nothing from the test leaves your browser. If the model isn't available, the test matches your task to control names inside the extension instead.

**What it stores.** The most recent report for each open tab is kept in Chrome's session storage so it reappears if you close and reopen the panel. It is deleted when the tab navigates to another page or closes, and when you quit Chrome.

To show what changed between audits, the extension also keeps, in Chrome's local storage on your computer, a short summary of the last audit of each page you audited: its URL, the time, the score, and each check's status and issue count. It doesn't keep page content. It keeps at most 200 pages, and you can delete it all with **Export → Clear audit history**. It also keeps a few counters in local storage: how many audits you've run, whether you've answered the rating request, and which version's "What's new" note you've seen.

**Toolbar badge.** After an audit, the page's score is shown on the extension's icon for that tab. It's cleared when the tab navigates.

**What it sends.** Nothing. The extension has no servers, no analytics, no tracking and no third-party code. Reports leave your browser only if you copy, download or share them yourself.

**When you install or remove it.** On install, the extension opens a welcome page that's part of the extension. When you remove it, Chrome opens a short, optional feedback page on agent-readiness-auditor.netlify.app. That page receives nothing from the extension: no identifier, no usage data. If you choose to fill in its form, only what you type is sent, and it's stored by our host, Netlify.

**Permissions.** Access to a page is granted only when you click the extension's icon, or if you choose "Allow on all sites" in the panel. You can remove that access at any time from `chrome://extensions`.

**Contact.** Questions about this policy: sabyasachi.mondal1@gmail.com.
