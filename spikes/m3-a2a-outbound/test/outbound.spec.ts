import { SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkEndpoint } from "../src/egress";
import type { Delivery } from "../src/index";

const BASE = "https://spike.test";
const SECRET_TEXT = "Rotate the payroll export";

let seq = 0;
async function offer(endpoint: string | null, status = "offered") {
  const id = `tsk_${++seq}_${Math.random().toString(36).slice(2, 8)}`;
  const task = { id, title: SECRET_TEXT, instructions: "Instructions that must never reach a log.", criteria: "Done when reviewed.", status, assignee: "agt_remote", endpoint };
  await SELF.fetch(`${BASE}/spike/task`, { method: "PUT", body: JSON.stringify(task) });
  const res = await SELF.fetch(`${BASE}/spike/offer`, { method: "POST", body: JSON.stringify({ taskId: id, attempt: 1 }) });
  expect(res.status).toBe(202);
  return id;
}

async function settled(taskId: string, until: (d: Delivery) => boolean = (d) => d.done, timeout = 15000) {
  let last: Delivery | null = null;
  await vi.waitFor(
    async () => {
      last = await (await SELF.fetch(`${BASE}/spike/delivery/${taskId}/1`)).json<Delivery | null>();
      if (!last || !until(last)) throw new Error(`not yet: ${JSON.stringify(last)}`);
    },
    { timeout, interval: 100 },
  );
  return last!;
}

const stats = async () => (await fetch("https://control.example.com/stats")).json<any>();

let logs: string[] = [];
beforeEach(() => {
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...args) => void logs.push(args.join(" ")));
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("the egress rules, as crates/egress has them", () => {
  it("allows a public https name, and refuses the rest", () => {
    expect(checkEndpoint("https://agent.example.com/a2a")).toMatchObject({ ok: true });
    const refused: [string, string][] = [
      ["http://agent.example.com/a2a", "not_https"],
      ["https://user:pw@agent.example.com/", "has_credentials"],
      ["https://agent.example.com:8443/", "not_default_port"],
      ["https://127.0.0.1/", "ip_address"],
      ["https://2130706433/", "ip_address"],
      ["https://0x7f.1/", "ip_address"],
      ["https://[::1]/", "ip_address"],
      ["https://169.254.169.254/latest", "ip_address"],
      ["https://localhost/", "not_public_name"],
      ["https://nas.lan/", "not_public_name"],
      ["https://gateway.podster.dev/a2a", "not_public_name"],
      ["https://agent.example.com/#x", "has_fragment"],
    ];
    for (const [url, refusal] of refused) expect(checkEndpoint(url)).toEqual({ ok: false, refusal });
  });
});

describe("an offer sent and read back", () => {
  it("SUBMITTED, then WORKING (accept), then COMPLETED (a submission, never a verify)", async () => {
    const id = await offer("https://steady-1.example.com/a2a");
    const d = await settled(id);
    expect(d.outcome).toBe("sent");
    expect(d.remoteStates[0]).toBe("TASK_STATE_SUBMITTED");
    expect(d.remoteStates).toContain("TASK_STATE_WORKING");
    expect(d.remoteStates.at(-1)).toBe("TASK_STATE_COMPLETED");
    expect(d.effects).toContain("accept_task");
    expect(d.effects.at(-1)).toBe("submit_task");
    expect(d.effects).not.toContain("verify_task");
    expect((await stats()).lastText).toContain(SECRET_TEXT);
  });

  it("COMPLETED with no WORKING is held, not accepted", async () => {
    const id = await offer("https://eager-1.example.com/a2a");
    const d = await settled(id);
    expect(d.remoteStates).toEqual(["TASK_STATE_COMPLETED"]);
    expect(d.effects).toEqual(["hold_unaccepted_response"]);
  });

  it("REJECTED declines", async () => {
    const d = await settled(await offer("https://reject-1.example.com/a2a"));
    expect(d.effects).toEqual(["decline_task"]);
  });
});

describe("what Podster won't do", () => {
  it("refuses a bad endpoint before sending anything", async () => {
    const before = (await stats()).sendMessage;
    for (const endpoint of ["http://steady-2.example.com/a2a", "https://127.0.0.1/a2a", "https://gateway.podster.dev/a2a"]) {
      const d = await settled(await offer(endpoint));
      expect(d.outcome).toBe("refused_endpoint");
    }
    expect((await stats()).sendMessage).toBe(before);
  });

  it("doesn't follow a redirect", async () => {
    const d = await settled(await offer("https://redirect.example.com/a2a"));
    expect(d.outcome).toBe("redirect_not_followed");
    expect(d.detail).toBe("302");
  });

  it("gives up on a slow agent within the timeout, and the queue retries once", async () => {
    const d = await settled(await offer("https://slow.example.com/a2a"), (x) => x.outcome === "timeout", 20000);
    expect(d.outcome).toBe("timeout");
  });

  it("sends nothing for a task that moved on before its turn in the queue", async () => {
    const before = (await stats()).sendMessage;
    const d = await settled(await offer("https://steady-3.example.com/a2a", "accepted"));
    expect(d.outcome).toBe("access_gone");
    expect((await stats()).sendMessage).toBe(before);
  });

  it("logs IDs only, never the task's text or the endpoint", async () => {
    await settled(await offer("https://steady-4.example.com/a2a"));
    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) {
      expect(line).not.toContain(SECRET_TEXT);
      expect(line).not.toContain("Instructions");
      expect(line).not.toContain("example.com");
    }
  });
});

describe("what a remote server does with a resent messageId", () => {
  it("is recorded, not assumed", async () => {
    const res = await SELF.fetch(`${BASE}/spike/resend`, { method: "POST", body: JSON.stringify({ endpoint: "https://steady-5.example.com/a2a", messageId: "resend-check-1" }) });
    const { remoteTaskIds } = await res.json<{ remoteTaskIds: (string | number | null)[] }>();
    // Printed so the README can say what the SDK server did. Either way Podster keys on its own attempt.
    expect(remoteTaskIds).toHaveLength(2);
    // The SDK's server makes a second task for the same messageId: it doesn't remove duplicates. So Podster can't rely
    // on a remote to dedupe (spec 3.3.1), and keys each send on its own attempt record instead.
    expect(typeof remoteTaskIds[0]).toBe("string");
    expect(remoteTaskIds[1]).not.toBe(remoteTaskIds[0]);
  });
});
