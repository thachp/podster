# M7's two-person staging run: setup sheet

M7's [step 16](m7-plan.md#build-order) on staging: two machines and two people, [as the owner decided on 2026-11-17](m7-plan.md#test-machines-the-owners-answer-of-2026-11-17). The owner runs Runner on their Mac, and Long runs it on Windows inside WSL2. Each person installs Runner with `npx podster@test`, pairs it with their own agent, and signs in to staging with their own account. Tasks go both ways, and the reviewer is always the person who didn't run the task. The run happens first with the nudge off, then with it on.

**It counts only with both people present.** With one machine, or with one person driving both, it's a rehearsal and is recorded as one.

The conductor is `e2e/m7-staging.mjs`, run by the owner from a checkout of `main`. It tells each person what to do, reads staging through the owner's own session, and records each criterion of [the gate's map](m7-plan.md#the-gates-map) as PASS, FAIL or NOT SHOWN. It writes nothing to staging and runs neither Runner nor Docker. Every task, cancel, review and grant change is made by a person in the web app or at their own Runner. Long's session never leaves his browser.

**Time:** 2 to 3 hours with both people on a call. The run longer than an hour (R-40) takes about 70 minutes of that, and nobody needs to do anything while it runs.

## Before the day, on each machine

| | Owner's Mac | Long's Windows machine |
| --- | --- | --- |
| Docker | Docker Desktop, running | WSL2 with a distro such as Ubuntu (`wsl --install`), then Docker Desktop with its WSL2 backend. In **Settings > Resources > WSL integration**, turn it on for the distro. In a new distro terminal, `docker version` must name a server. |
| Node | Node 22 or later | Node 22 or later, installed **inside the distro**, not on Windows |
| Git | 2.25 or later at `/usr/bin/git`, `/opt/homebrew/bin/git` or `/usr/local/bin/git` | The same, inside the distro (`/usr/bin/git`) |
| Folders | Plain paths only: letters, digits, `.`, `_`, `-` and `/` | Runner's home (`~/.podster-runner`) and the workspace root (`~/podster-work`) in the distro's own file system, never under `/mnt/c` |
| Runner | `npx --ignore-scripts podster@test --help` lists `trust` | The same, from the distro's terminal |

**The Anthropic API key** goes in a file that only you can read, the way Runner expects. Make a key for this run with a **spending limit of 10 USD** set at Anthropic, and don't paste it into an editor:

```bash
read -rs k
printf '%s' "$k" > ~/podster-anthropic.key
chmod 600 ~/podster-anthropic.key
unset k
head -c 7 ~/podster-anthropic.key   # prints sk-ant-
```

**Spend:** each key's 10 USD limit bounds the run at 20 USD in all, well inside the owner's model budget of 100 USD a month. Runner's caps bound it more tightly. In `policy.json`, `caps` (one run) and `day_caps` (all runs in a day) apply to **the whole machine**, across every room in the file, not to one room. So each person sets `day_caps.spend_micro_usd` to 8000000 (8 USD) before starting, so that the day cap doesn't stop the run partway. Keep `caps.spend_micro_usd` at the starter's 500000 (0.50 USD) for the ordinary runs. Only the long run raises it, to 5000000, on the machine that runs it. About twelve short runs and one long run come to roughly 11 USD across both machines.

**The nudge half:** each person needs a public HTTPS address they control that forwards to `127.0.0.1:<port>` on their own machine with the path unchanged, such as a tunnel they run or a reverse proxy. Podster accepts only `https://` at a DNS name on the default port. Start the forward on the day, not before.

**The Runner version:** use the first test pre-release published after PRs 622 (held pushes) and 623 (`podster trust`) merged. If `--help` doesn't list `trust`, stop there: the run waits for that release.

## The owner also prepares

- **The room.** Use a room you own whose repository under `podsterdev` is linked and ready. A private repository is best. With a public one, Runner asks before every push, which is PR 622's rule, and you answer `y` each time. Don't list any `network` hosts for the room.
- **The conductor's session.** Sign in to staging in your browser. Then, in the developer tools, open Application, then Cookies, and copy the value of `__Secure-better-auth.session_token` on the application host. In the terminal where you'll run the conductor:

  ```bash
  read -rs PODSTER_E2E_COOKIE_A && export PODSTER_E2E_COOKIE_A   # paste __Secure-better-auth.session_token=<value>
  cd e2e && node m7-staging.mjs --dry-run                          # the plan; reads nothing
  node m7-staging.mjs                                              # the run
  ```

  The conductor refuses `PODSTER_E2E_COOKIE_B` and `PODSTER_E2E_SIGNUP_SECRET`: Long's session is never asked for, and no test person is made. It never prints your session or signs it out. Sign out in the browser when you're done.
- **A rehearsal first, if you like:** `node m7-staging.mjs --rehearsal`, alone on the Mac. With both machines, add `--two-machines`. A rehearsal never counts as the gate.

## On the day

The conductor asks for each step by name ("First person", "Second person"). The owner types each answer: `y` or `n`, an ID, a count, or a word. Long reads his answer aloud from his own machine. `skip` records a clause as NOT SHOWN, and `stop` ends the run.

1. **Pair.** Each person adds an agent for their machine in the web app and starts its pairing. Then they run `npx --ignore-scripts podster@test pair --agent <agt_…>`, paste the code when asked, approve the key and check that the fingerprint matches. `npx --ignore-scripts podster@test status` prints the agent's ID. Before pairing, the conductor has each person run Runner from an empty home to show that it refuses (R-01). On the Mac, paste a wrong code first, with one character changed, and then the right one (R-26). The conductor reads that pairing's record, and checks that the owner's session can't read Long's pairing (R-28).
2. **Into the room.** The owner invites Long's organization. Long accepts, adding his agent. The owner gives both agents a push grant.
3. **Run policy.** Each person runs `npx --ignore-scripts podster@test setup --room <ws_…>`, keeping `mode: "ask"` and `outputs: "hold"`. The owner says yes to adding Long's organization to `allowed_orgs`. Long leaves the owner's organization out until the scope check is done, then adds it. Each person then starts Runner with `npx --ignore-scripts podster@test run --provider-key-file ~/podster-anthropic.key`. On Long's machine, the conductor records that Runner's Linux checks passed (`adapter.platform linux_checked`) and which key store it printed (usually `file` under WSL2).
4. **The nudge off.** The conductor asks each person for a listening-port count (`lsof` on the Mac, `ss` in WSL2), which should be 0. Then come the tasks: a scope check, an ask-first run in each direction, a hard kill between the pull request and the submission, an offer made while Runner is stopped, a cancel during a run, a run over its turn cap, an unattended run in each direction with a request for changes, a push grant taken back, and the long run.
   - **Ask screens.** In the ask-first room, Runner shows each run before it starts. Answer `y` at Runner's terminal.
   - **The push question** (PR 622). When the room holds outputs, or the repository is public, Runner asks *Push the task branch and open its pull request?* after a run. Answer `y`. For the canceled task, answer `n`.
   - **Unattended runs need the trust statement** (PR 623). Set `mode: "unattended"` and `outputs: "share"` for the room in `policy.json`, raising `revision`. Then run `npx --ignore-scripts podster@test trust <ws_…>`, read the whole statement and type `accept`. A file can't accept it for you. Without it, an unattended room still asks before each run (`trust_statement_not_accepted`).
   - **The long run.** The conductor asks which machine runs it. Long's machine also shows it under WSL2. On that machine, add `"shell"` to the room's `tools`, and set `caps.run_time_ms` to 5400000, `caps.turns` to 150 and `caps.spend_micro_usd` to 5000000. These caps cover the whole machine, so no other task should run there meanwhile. Leave the day cap at 8 USD. Put everything back afterwards.
5. **The nudge on.** Each person starts their forward and restarts Runner with `--interval 900 --nudge-listen <port> --nudge-url <https://…>`. When Runner prints the endpoint's version, the person switches the nudge on for that version on their agent's page. The conductor sends probes only to the address Podster holds as that agent's endpoint, and only when its name resolves to public addresses. It reads the owner's endpoint itself, and Long confirms his. It sends three small requests to each address and expects Runner's own refusals: 401 for one with no signature, 401 for one with a wrong signature, and 413 for one that's too large (R-03, R-16). A malformed body isn't sent. Runner checks the signature first, so a malformed body would only show 401 again, and it's recorded NOT SHOWN. After that, an offer each way should be picked up within 5 minutes under the 15-minute poll (R-17). Last, each Runner is stopped and its address checked again (R-15).
6. **Teardown,** below.

The report goes in `e2e/m7-staging-gate-<time>.json`, or `-rehearsal-` for a rehearsal. It holds IDs only: the room, the two agents, the tasks, statuses and counts. People are named by role. The conductor checks the report for person IDs, emails and credentials before writing it, and writes it after every step, so a stopped run keeps what it showed. An evidence PR that carries it uses a non-`docs/` branch. The gate call is the owner's.

## Stopping safely, at any point

- **Runner:** press Ctrl-C in its terminal, or run `npx --ignore-scripts podster@test stop` from another one. Either one ends any run at once, and Runner polls nothing until it's started again. To stop unattended runs without stopping Runner, set the room's `mode` back to `"ask"`. That takes effect at the next evaluation.
- **The conductor:** type `stop`, or press Ctrl-C. The report so far is kept. Nothing on staging needs undoing because the conductor wrote nothing there.
- **The nudge:** switch it off on the agent's page, then stop the forward.
- **What's left:** each person runs the conductor's teardown count, `docker ps -aq` and `docker network ls -q` filtered on the label `dev.podster.runner.run`, which should be 0. On Long's machine, that's the WSL2 teardown record. Tasks, the room and the pull requests stay on staging, as every staging run's do. Afterwards, each person can disconnect their agent in the web app and run `npx --ignore-scripts podster@test forget`, and revoke the key at Anthropic if it was made for this run.
