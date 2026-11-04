# Agent-readiness checks: what each one means and how to fix it

The audit runs 42 checks in ten categories. Each check scores 0–100; 95+ passes, 70–94 is a warning, below 70 fails. In reports and JSON, use the **check id** to find the entry here.

Fix in this order: failing checks with a high weight first (weight 3 counts three times as much as weight 1). Checks under "Agent protocols" are information only and never affect the score.

## Real controls

### `fake-controls`: Clickable elements without a control role

- **Why:** Agents look for buttons and links in the accessibility tree. A div that only looks clickable isn’t listed there, so agents skip it or have to guess from pixels.
- **Fix:** Use a real <button> or <a href>. If that isn’t possible, add role="button", tabindex="0" and keyboard handlers.
- **Weight:** 3
- **Also WCAG 2.2:** 4.1.2 Name, Role, Value (A), 2.1.1 Keyboard (A)

### `dead-links`: Links that don’t go anywhere

- **Why:** A link promises navigation. Links with no href, “#” or “javascript:” only work through scripts, so agents may open them in a new tab, get nothing, or skip them.
- **Fix:** Give real links a destination URL. If the element performs an action instead, make it a <button>.
- **Weight:** 2
- **Also WCAG 2.2:** 2.1.1 Keyboard (A), 4.1.2 Name, Role, Value (A)

### `keyboard-reachable`: Controls you can’t reach with the Tab key

- **Why:** Agents that drive the page with the keyboard, and people who can’t use a mouse, move between controls with Tab. A button or link with tabindex="-1" is skipped, so it can only be reached by clicking.
- **Fix:** Remove tabindex="-1" from standalone controls. Keep it only for items inside a widget that manages focus itself, such as menu items, tabs or options with arrow-key navigation.
- **Weight:** 2
- **Also WCAG 2.2:** 2.1.1 Keyboard (A)

### `focus-visible`: No visible focus indicator

- **Why:** When an agent or a keyboard user moves to a control, a visible outline shows where they are. Agents that work from screenshots check it to confirm the right control is focused before they press Enter.
- **Fix:** Don’t remove the focus outline. If the design needs a custom one, style :focus-visible with an outline or a box-shadow that contrasts with the background.
- **Weight:** 1
- **Also WCAG 2.2:** 2.4.7 Focus Visible (AA)

### `positive-tabindex`: Positive tabindex values

- **Why:** tabindex above 0 overrides the natural order of the page, so agents that move with the keyboard jump around unpredictably.
- **Fix:** Use tabindex="0" or remove it, and order elements in the DOM the way they should be reached.
- **Weight:** 1
- **Also WCAG 2.2:** 2.4.3 Focus Order (A)

## Labels and names

### `unnamed-controls`: Controls with no name

- **Why:** An agent told to “click Save” looks for a control named Save. Icon-only buttons and empty links have no name to match, so the agent has to guess.
- **Fix:** Add visible text, an aria-label, or alt text on the icon image. For SVG icons, put aria-label on the button itself.
- **Weight:** 4
- **Also WCAG 2.2:** 4.1.2 Name, Role, Value (A), 2.4.4 Link Purpose (In Context) (A)

### `vague-names`: Vague or duplicated control names

- **Why:** Names like “Click here”, or ten links all called “Learn more”, don’t say where they lead. Agents can’t tell them apart without studying the layout around them.
- **Fix:** Make each name describe its target, like “Read the pricing guide”. If the visible text must stay short, add an aria-label with the full meaning.
- **Weight:** 2
- **Also WCAG 2.2:** 2.4.4 Link Purpose (In Context) (A), 2.4.6 Headings and Labels (AA)

### `image-alt`: Images without alt text

- **Why:** Agents that read the page as text see nothing for an image without alt. Product photos, charts and meaningful icons disappear.
- **Fix:** Add alt text that describes the image. For purely decorative images, use alt="" so agents can skip them.
- **Weight:** 1
- **Also WCAG 2.2:** 1.1.1 Non-text Content (A)

### `aria-misuse`: ARIA that gives agents wrong information

- **Why:** Agents trust ARIA completely. A focusable element marked aria-hidden, a label that points at a missing id, or an aria-label that doesn’t match the visible text tells the agent something false, and it can’t tell that anything is wrong.
- **Fix:** Remove aria-hidden from anything focusable, point aria-labelledby and aria-describedby at ids that exist, use valid roles and true/false values, and start each aria-label with the control’s visible text.
- **Weight:** 3
- **Also WCAG 2.2:** 4.1.2 Name, Role, Value (A), 2.5.3 Label in Name (A), 1.3.1 Info and Relationships (A)

## Forms

### `unlabeled-fields`: Form fields without labels

- **Why:** Agents fill forms by matching field labels to the information they have. A field with no label, or only placeholder text, is a guess, and placeholders vanish once typing starts.
- **Fix:** Connect a <label for> to each field, or wrap the field in a <label>. Use aria-label only when a visible label isn’t possible.
- **Weight:** 4
- **Also WCAG 2.2:** 3.3.2 Labels or Instructions (A), 1.3.1 Info and Relationships (A), 4.1.2 Name, Role, Value (A)

### `field-hints`: Fields missing type or autocomplete hints

- **Why:** type="email" and autocomplete="email" tell an agent exactly what a field wants. Without them it infers from nearby text and often formats the data wrong.
- **Fix:** Use the matching input type (email, tel, url, date) and add autocomplete tokens such as name, email, tel, street-address and postal-code.
- **Weight:** 2
- **Also WCAG 2.2:** 1.3.5 Identify Input Purpose (AA)

### `required-fields`: Required fields not marked as required

- **Why:** An asterisk is only visual. Without the required attribute, agents submit forms with missing fields and then have to recover from errors.
- **Fix:** Add the required attribute, or aria-required="true", to every field the form needs.
- **Weight:** 1
- **Also WCAG 2.2:** 3.3.2 Labels or Instructions (A), 1.3.1 Info and Relationships (A)

## Interaction traps

### `overlays`: Overlays covering the page

- **Why:** Cookie banners, sign-up modals and interstitials sit on top of the content. Agents often click the overlay by mistake, or can’t reach what’s underneath until it’s dismissed.
- **Fix:** Give overlays a clearly named close button, keep them away from main content, and mark modals with role="dialog", aria-modal="true" and a name.
- **Weight:** 3
- **Also WCAG 2.2:** 2.4.11 Focus Not Obscured (Minimum) (AA), 4.1.2 Name, Role, Value (A)

### `bot-challenges`: Bot challenges

- **Why:** CAPTCHAs and bot checks are built to stop automated visitors, including agents acting for a real person. A challenge on a key flow can end the task.
- **Fix:** Keep challenges off routine flows, prefer risk-based checks that rarely show a puzzle, and use your provider’s options for verified agents where available.
- **Weight:** 2

### `frames`: Content inside cross-origin frames

- **Why:** Agents and their tools often can’t read or click inside iframes from another domain. Checkout, login or booking widgets embedded this way can be unreachable.
- **Fix:** Host key flows on your own domain, or use your provider’s redirect or API option instead of an embedded frame.
- **Weight:** 2

### `small-targets`: Very small click targets

- **Why:** Agents that work from screenshots click by coordinates. Tiny targets, smaller than 24 × 24 pixels or thinner than 16 pixels, are easy to miss or to confuse with their neighbours.
- **Fix:** Make clickable areas at least 24 × 24 pixels, using padding if the visible icon is smaller.
- **Weight:** 1
- **Also WCAG 2.2:** 2.5.8 Target Size (Minimum) (AA)

### `layout-shifts`: Layout shifts while loading

- **Why:** Agents read the page, decide where to click, then click. If buttons move in between, because images, ads or banners load late, the click lands on the wrong thing.
- **Fix:** Reserve space for images, ads, embeds and banners with width and height or aspect-ratio, and don’t insert content above what’s already on screen.
- **Weight:** 1

### `shadow-dom`: Controls inside shadow DOM and frames

- **Why:** Shadow DOM and iframes hide elements from ordinary selectors. Agents built on Playwright or the DevTools protocol read open shadow roots and same-site frames, but simpler scripts don’t, and closed shadow roots are hidden from all of them.
- **Fix:** Prefer open shadow roots, make sure web components expose their names and roles, and keep key flows out of cross-site frames.

## Stable targeting

### `generated-classes`: Controls identified only by generated class names

- **Why:** Class names like css-1x2y3z or Button_root__a8F3k change whenever the site is rebuilt. Agents and automations that remember these selectors break after every release.
- **Fix:** Add a stable hook to important controls: a meaningful id, a name, or a data attribute such as data-testid or data-action.
- **Weight:** 2

### `dynamic-ids`: Auto-generated IDs

- **Why:** IDs like :r4: or input-83412 are created at runtime and change between visits. Selectors and label links that point at them are fragile.
- **Fix:** Give important controls readable, permanent IDs, or rely on name and data-testid attributes instead.
- **Weight:** 2

## Page structure

### `page-title`: Descriptive page title

- **Why:** The title is often the first thing an agent reads to confirm it’s on the right page, and it’s how the agent tells tabs apart.
- **Fix:** Write a unique title that names the page and the site, like “Order history | Acme”.
- **Weight:** 2
- **Also WCAG 2.2:** 2.4.2 Page Titled (A)

### `page-language`: Page language declared

- **Why:** The lang attribute tells agents which language to read and write in, which matters for form input, translation and dates.
- **Fix:** Set lang on the <html> element, like <html lang="en">.
- **Weight:** 1
- **Also WCAG 2.2:** 3.1.1 Language of Page (A)

### `landmarks`: Main content and navigation landmarks

- **Why:** Landmarks let an agent jump straight to the main content or the site navigation instead of reading the whole page in order.
- **Fix:** Wrap the primary content in <main> and site navigation in <nav>, and use <header> and <footer> for page chrome.
- **Weight:** 2
- **Also WCAG 2.2:** 1.3.1 Info and Relationships (A), 2.4.1 Bypass Blocks (A)

### `headings`: Heading outline

- **Why:** Headings are how agents skim. One clear h1 and a logical outline let them find the right section quickly.
- **Fix:** Use one h1 for the page topic, and step down one level at a time (h2, then h3) without skipping levels.
- **Weight:** 2
- **Also WCAG 2.2:** 1.3.1 Info and Relationships (A), 2.4.6 Headings and Labels (AA)

### `dom-size`: Page size and nesting

- **Why:** Agents read a trimmed copy of the page within a limited context. Very large or deeply nested pages get cut off, so content near the end may never be seen.
- **Fix:** Remove hidden duplicate markup, virtualize long lists, and flatten wrappers that only exist for styling.
- **Weight:** 1

### `nojs-content`: Content that needs JavaScript

- **Why:** Many agents and AI crawlers fetch a page without running its scripts. Anything added by JavaScript, such as prices, product details or a whole single-page app, is missing for them.
- **Fix:** Render the main content, headings, prices and primary actions on the server (server-side rendering or static generation), and include structured data in the HTML rather than adding it with a tag manager.
- **Weight:** 2

### `content-start`: Where the main content starts

- **Why:** Agents read the page from the top and often cut it off to fit their context. If menus, mega-navigation and banners come first, the agent spends its budget on them and may never reach the content.
- **Fix:** Keep the header and navigation lean, put long menus behind a button that expands them, move secondary blocks after <main>, and mark the main content with <main>.
- **Weight:** 1

## Agent safety

### `hidden-instructions`: Hidden instructions aimed at agents

- **Why:** Text that people can’t see but agents read, such as invisible spans, off-screen blocks, aria-labels or HTML comments saying “ignore previous instructions”, is a prompt injection. Agents may follow it, and agent browsers increasingly warn about or refuse sites that contain it.
- **Fix:** Remove hidden text that addresses AI agents. If you want to guide agents, say it openly: in visible text, in llms.txt, or in structured data.
- **Weight:** 3

## Shopping agents

### `product-schema`: Product structured data

- **Why:** AI shopping agents compare products from structured data, not from the layout. Without a Product block they have to guess the name, brand and model from the page text, and often skip the product.
- **Fix:** Add JSON-LD of type Product with name, image, description, brand, and an identifier such as sku, gtin or mpn. Most shop platforms and SEO plugins can output it.
- **Weight:** 3

### `product-offer`: Price and availability for agents

- **Why:** Before an agent recommends or buys a product, it needs the price, the currency and whether it’s in stock. If structured data leaves these out, or shows a different price than the page, agents skip the product or quote the wrong price.
- **Fix:** Add an offers object to the Product with price, priceCurrency and availability (for example https://schema.org/InStock), and keep the price the same as the one shown on the page.
- **Weight:** 3

### `purchase-info`: Shipping, returns and reviews

- **Why:** Shopping agents weigh delivery cost, return terms and ratings when they compare stores. If these are only in the page text or on another page, the agent may not find them at all.
- **Fix:** Add shippingDetails and hasMerchantReturnPolicy to the offer, and aggregateRating (or review) to the Product.
- **Weight:** 2

### `cart-button`: A clear “Add to cart” button

- **Why:** To buy, an agent looks for a button named like “Add to cart”. If the button is a styled div, an icon without a name, or uses wording agents don’t expect, the purchase stalls.
- **Fix:** Use a real <button> with visible text such as “Add to cart”, “Add to bag” or “Buy now”. If it’s an icon, add an aria-label.
- **Weight:** 2
- **Also WCAG 2.2:** 4.1.2 Name, Role, Value (A)

## Machine-readable signals

### `metadata`: Description and link metadata

- **Why:** A meta description and Open Graph tags give agents a one-line summary of the page before they read it, and help them cite it correctly.
- **Fix:** Add <meta name="description">, og:title, og:description, and a <link rel="canonical"> pointing at the preferred URL.
- **Weight:** 2

### `structured-data`: Structured data

- **Why:** Schema.org data states facts like price, availability, author and dates in a form agents can read without interpreting the layout.
- **Fix:** Add JSON-LD for the page’s main subject, such as Product, Article, Organization, Event or FAQPage.
- **Weight:** 2

### `llms-txt`: llms.txt file

- **Why:** llms.txt is an emerging convention: a plain-text guide to a site, written for language models. Few sites have one yet, so it’s an inexpensive way to help agents.
- **Fix:** Publish /llms.txt at the root of the site with a short description and Markdown links to its most useful pages.
- **Weight:** 1

### `robots-ai`: robots.txt rules for AI agents

- **Why:** Some agents check robots.txt before acting for a person. Blocking user-triggered agents such as ChatGPT-User or Claude-User can stop them from opening your pages at all.
- **Fix:** Decide deliberately which agents to allow. Blocking training crawlers (GPTBot, ClaudeBot, Google-Extended) is separate from blocking agents that browse on someone’s behalf.
- **Weight:** 1

## Agent protocols (information only, not scored)

### `markdown-negotiation`: Markdown version for agents

- **Why:** Some agents ask for a page with Accept: text/markdown. Serving Markdown saves them the tokens spent on markup, scripts and navigation.
- **Fix:** Return a Markdown rendering when a request sends Accept: text/markdown (and send Vary: Accept), or link one with <link rel="alternate" type="text/markdown" href="…">.

### `discovery-links`: Sitemap and Link headers

- **Why:** A sitemap lists the pages an agent can visit. Link response headers (RFC 8288) can point an agent straight to an API catalog, documentation or a Markdown version.
- **Fix:** Publish /sitemap.xml and reference it from robots.txt with a Sitemap: line. If you have an API or docs, add Link headers such as rel="api-catalog" or rel="service-doc".

### `mcp-discovery`: MCP server card

- **Why:** An MCP server card at /.well-known/mcp/server-card.json tells agents the site offers tools over the Model Context Protocol, and how to connect and sign in. It’s a draft with very little adoption so far.
- **Fix:** If you run an MCP server, publish its card at /.well-known/mcp/server-card.json with its name, transport URL and authentication details.

### `api-discovery`: API, sign-in and skills discovery

- **Why:** Sites with an API or accounts can tell agents where things are: an API catalog (RFC 9727), OAuth metadata (RFC 8414 and RFC 9728) so agents can ask for access instead of borrowing a person’s session, and an Agent Skills index.
- **Fix:** If you offer an API, publish /.well-known/api-catalog. If agents should sign in, publish OAuth authorization-server and protected-resource metadata. Content-only sites can skip this.

### `content-signals`: Content Signals in robots.txt

- **Why:** Content Signals let a site say separately whether its content may be used for search, for AI answers (ai-input) and for AI training (ai-train), instead of blocking crawlers outright.
- **Fix:** Add a line such as Content-Signal: search=yes, ai-input=yes, ai-train=no to robots.txt.

### `webmcp`: WebMCP tools

- **Why:** WebMCP lets a page offer agents named tools, like “search_flights”, instead of making them click through the interface. It’s an origin trial in Chrome with almost no adoption yet, so it’s optional.
- **Fix:** Add toolname and tooldescription to key forms, give every field a name and a label, or register tools in script with the registerTool() method of document.modelContext.

