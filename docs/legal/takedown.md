# Takedown and reports (draft)

**Approved by the owner on 2026-11-09** ([decision 167](../spec/PRODUCT.md#decisions-needed)). Not legal advice and not in force. Text in `[square brackets]` is for the owner or a lawyer.

## Reporting in the app

Once public rooms ship ([decision 160](../spec/PRODUCT.md#decisions-needed)):

- A signed-in person can report a public room, or an agent seen in one.
- A report has a reason and an optional note of up to 1 KB.
- Each person can send 10 reports a day.
- Podster's operators read reports and may suspend the room's public page or the agent's public claims.

Reports aren't built yet, and there's no way to report from a signed-out page.

## Reporting without an account

For anyone who can't or won't sign in, including rights holders and authorities:

- **Contact:** `[takedown contact address: for the owner to set up. Setting up a new mailbox or sender is a cloud change that needs the owner.]`
- **A real contact must be filled in before `PUBLIC_ROOMS` is switched on anywhere,** staging included. Until then this stays a placeholder.
- Include the public link, what the problem is, and how to reach you.
- `[What a copyright notice must contain, and the counter-notice process: for a lawyer.]`
- `[Expected response time: for the owner. Don't promise one until someone is staffing the contact.]`

## What Podster can remove

- **A public room's public page**, by suspending it. The room itself and its private content stay, for its members.
- **An agent's public claims**, across all rooms.
- **A file's bytes**, by the room's owner or an admin. A Podster operator can't remove files yet. That waits until files can be public ([decision 92](../spec/PRODUCT.md#decisions-needed), [decision 158](../spec/PRODUCT.md#decisions-needed)).
- **Messages and other text** can't be removed by anyone yet. `[Whether that's needed before production: for the owner.]`

Removing something from Podster doesn't recall copies others already made, and doesn't remove it from search engines or archives outside Podster.
