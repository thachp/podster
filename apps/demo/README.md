# Podster demo

A clickable prototype of Podster's web app. It's one static HTML file with no build step and no backend: every screen, click and state is mocked in the page.

Since 2026-11-24 (owner ruling), this demo is Podster's source of truth for UI and UX: layout, visual design, interaction flow, navigation and on-screen wording. It wins over the screens in `docs/spec/DESIGN.md` and over `docs/mockups/`. It talks to nothing, so it can't settle or loosen authority, permissions, visibility, data or security; those still come from `docs/spec/PRODUCT.md`, `ACCESS-CONTROL.md` and `ARCHITECTURE.md`. Where the demo shows something those specs forbid, the specs win and the gap is a design question to raise.

It's live at https://demo.podster.dev, served as static files by the `podster-demo` Worker. It talks to nothing of Podster's, and search engines are asked not to index it.

## Open it

Open `index.html` in a browser, or serve this folder:

```bash
python3 -m http.server 8765 --bind 127.0.0.1
```

Then go to http://localhost:8765/. The page loads the Geist fonts from Google Fonts.

## What's in it

- **Three people.** Elena owns workrooms, Sam brings a coding agent, and Marco is a teammate without owner rights. Switch between them from the account menu at the bottom left ("Demo · see it as …").
- **Owner screens:** Today, Brief, Board (List, Board and Gantt views), task pages and sheets, review with a live preview and code view, Ship, History, Team, Rules, App settings with plain and secret environment variables, Code and releases, Your workrooms grouped by Personal and team organizations, Create an organization, Organization settings (name, web address, logo and people), and a brand-new workroom.
- **Contributor screens:** Today, pairing an agent, Explore and public workroom pages, runs with a live log, Your agents, Spend, and track record.
- **Outside the app:** sign in with Google, GitHub or X, or an email link; the role choice after sign-in; problems at the door, such as expired links, wrong-email invites and no access; and emails.
- **Everywhere:** ⌘K to jump or type a command, "Connect your chat" over MCP for Claude, ChatGPT and Grok, light and dark themes, and `?` for keyboard shortcuts.

Buttons marked "Demo · …" fake something that would happen elsewhere, such as an agent finishing or a person accepting.

## Design rules it follows

- A monochrome shell. Orange means only "this needs you".
- One working column per page. Detail and review panels open as a wide sheet on the right, not a dialog.
- Three kinds of page control, each with one job (owner, 2026-11-27):
  - **Underline tabs** (`tabs()`) switch to genuinely different content, under the page title. Ship and the organization's agent inbox use them.
  - **View switch** (`viewSwitch()`) shows the same content in another layout, as small icon buttons at the top right next to the page's main button. Board / List / Timeline and History's feed / map use it.
  - **Filter** narrows the same content: a two-option `.seg`, or a "Show ▾" select at the right end of an existing row, never on a row of its own.
  - A segmented control (`.seg`) otherwise only picks a value in a form or toolbar.
- Agent content is data. Markdown from agents renders as text, and their links show the address instead of being clickable.

## Deploy it

The Worker is on the Cloudflare account that holds `podster.dev`. Only `public/` is served: its `_headers` (a strict content security policy, no framing, `noindex`) and the copy of `index.html` the deploy script puts there.

```bash
npm ci
```

```bash
CLOUDFLARE_ACCOUNT_ID=$(cat ~/.podster/cloudflare-account-id.staging) npm run deploy
```

`npm run deploy` runs `check.cjs` first and stops if it fails. Deploying is a person's call, as for staging.

## Check it after a change

```bash
node check.cjs
```

It runs every view and the main flows under a small DOM stub. It prints one line per group, ending with `AUTH-OK`, and throws on the first error. It doesn't check layout. Look at the screens you changed in a browser.
