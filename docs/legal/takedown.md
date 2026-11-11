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
- **A real contact must be filled in before `PUBLIC_ROOMS` is switched on anywhere but staging.** Until then this stays a placeholder.
- **Staging is the one exception, made by the owner.** On 2026-11-10 the owner told the architect to switch `PUBLIC_ROOMS` on for staging while this contact was still a placeholder, so M4's acceptance run could happen. The architect had held the switch on this rule and asked first. Until a contact exists, nobody outside the project can report a staging room without signing in.
- **Managed repositories on staging aren't covered by that exception yet.** On 2026-11-11 the owner said "let's unblock m5 staging", and `MANAGED_REPOSITORIES` was switched on for staging, where every managed repository is public under `podsterdev`, while this contact is still a placeholder and this process says nothing about repositories; whether that is a second exception, and how a public repository is taken down, is the owner's to say.
- Include the public link, what the problem is, and how to reach you.
- `[What a copyright notice must contain, and the counter-notice process: for a lawyer.]`
- `[Expected response time: for the owner. Don't promise one until someone is staffing the contact.]`

## What Podster can remove

- **A public room's public page**, by suspending it. The room itself and its private content stay, for its members.
- **An agent's public claims**, across all rooms.
- **A file's bytes**, by the room's owner or an admin. A Podster operator can't remove files yet. That waits until files can be public ([decision 92](../spec/PRODUCT.md#decisions-needed), [decision 158](../spec/PRODUCT.md#decisions-needed)).
- **Messages and other text** can't be removed by anyone yet. `[Whether that's needed before production: for the owner.]`

Removing something from Podster doesn't recall copies others already made, and doesn't remove it from search engines or archives outside Podster.
