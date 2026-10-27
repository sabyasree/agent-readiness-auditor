# Privacy policy: Agent-Readiness Auditor

Last updated: October 27, 2026

Agent-Readiness Auditor analyzes the web page you choose to audit and shows the results in Chrome's side panel.

**What it reads.** When you run an audit, the extension reads the structure of the current page (its elements, attributes and visible text) inside your browser. It also makes a few requests to the same website, the way any visitor's browser could: the page's own URL again (once as a normal page, with your existing cookies, to compare it with what scripts render, and once asking for a Markdown version), and `/llms.txt`, `/robots.txt`, `/sitemap.xml` and a few standard discovery files under `/.well-known/`. These requests go only to the website you are auditing.

**What it stores.** The most recent report for each open tab is kept in Chrome's session storage so it reappears if you close and reopen the panel. It is deleted when the tab navigates to another page or closes, and when you quit Chrome.

To show what changed between audits, the extension also keeps, in Chrome's local storage on your computer, a short summary of the last audit of each page you audited: its URL, the time, the score, and each check's status and issue count. It doesn't keep page content. It keeps at most 200 pages, and you can delete it all with **Export → Clear audit history**.

**What it sends.** Nothing. The extension has no servers, no analytics, no tracking and no third-party code. Reports leave your browser only if you copy or download them yourself.

**Permissions.** Access to a page is granted only when you click the extension's icon, or if you choose "Allow on all sites" in the panel. You can remove that access at any time from `chrome://extensions`.

**Contact.** Questions about this policy: sabyasachi.mondal1@gmail.com.
