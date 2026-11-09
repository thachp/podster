import { describe, expect, it, vi } from "vitest";
import { clientKey, underLimit } from "./limit";

const headers = (values: Record<string, string>) => new Headers(values);

describe("who a public page request counts as", () => {
  it("counts every address in one IPv6 /64 as one client, however it's written", () => {
    const a = clientKey(headers({ "cf-connecting-ip": "2001:db8:abcd:12:1111:2222:3333:4444" }));
    const b = clientKey(headers({ "cf-connecting-ip": "2001:0DB8:ABCD:0012::9" }));
    expect(a).toBe("2001:db8:abcd:12");
    expect(b).toBe(a);
    expect(clientKey(headers({ "cf-connecting-ip": "2001:db8:abcd:13::1" }))).not.toBe(a);
    expect(clientKey(headers({ "cf-connecting-ip": "::1" }))).toBe("0:0:0:0");
  });

  it("counts Cloudflare's Worker address per calling zone, not as one client", () => {
    const worker = (zone?: string) => clientKey(headers({ "cf-connecting-ip": "2a06:98c0:3600::103", ...(zone ? { "cf-worker": zone } : {}) }));
    expect(worker("one.example")).toBe("worker:one.example");
    expect(worker("two.example")).toBe("worker:two.example");
    expect(worker()).toBe("worker:unknown");
  });

  it("keeps an IPv4 address whole, and puts requests with no address in one bucket", () => {
    expect(clientKey(headers({ "cf-connecting-ip": "203.0.113.9" }))).toBe("203.0.113.9");
    expect(clientKey(headers({}))).toBe("unknown");
  });

  it("asks the limiter with that key", async () => {
    const limit = vi.fn(async () => ({ success: true }));
    await underLimit({ limit }, { headers: headers({ "cf-connecting-ip": "2001:db8:abcd:12::7" }) });
    expect(limit).toHaveBeenCalledWith({ key: "2001:db8:abcd:12" });
  });
});
