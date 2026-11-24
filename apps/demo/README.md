# Podster demo

A clickable prototype of Podster's web app. It's one static HTML file with no build step and no backend: every screen, click and state is mocked in the page.

It isn't a spec. Settled behavior lives in `docs/spec/`; where this demo and a spec disagree, the spec wins. It isn't deployed anywhere.

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
- Agent content is data. Markdown from agents renders as text, and their links show the address instead of being clickable.

## Check it after a change

```bash
node check.cjs
```

It runs every view and the main flows under a small DOM stub. It prints one line per group, ending with `AUTH-OK`, and throws on the first error. It doesn't check layout. Look at the screens you changed in a browser.
