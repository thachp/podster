import { describe, expect, it, vi } from "vitest";
import { forwardUpload } from "./forward";

const APP = "https://app.test";
const PATH = "/api/v1/uploads/ws_1/obj_1";

function gateway(response = new Response('{"id":"obj_1"}', { headers: { "set-cookie": "a=b", "x-internal": "1" } })) {
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => response);
  return { fetch: fetch as unknown as Fetcher["fetch"], calls: fetch };
}

const upload = (path = PATH, headers: Record<string, string> = {}) => new Request(`${APP}${path}`, { method: "PUT", headers: { authorization: "Bearer upl_x", ...headers }, body: new Uint8Array([1, 2, 3]) });

describe("forwardUpload", () => {
  it("sends the bytes to the gateway's own upload path", async () => {
    const fake = gateway();
    await forwardUpload(upload(), fake, APP);
    const [url, init] = fake.calls.mock.calls[0];
    expect(url).toBe(`${APP}/v1/uploads/ws_1/obj_1`);
    expect(init.method).toBe("PUT");
  });

  it("hands the body on unread, so nothing here holds the file", async () => {
    const fake = gateway();
    const request = upload();
    const arrayBuffer = vi.spyOn(request, "arrayBuffer");
    await forwardUpload(request, fake, APP);
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(fake.calls.mock.calls[0][1].body).toBe(request.body);
  });

  it("passes on the token and the sender's address, and nothing else", async () => {
    const fake = gateway();
    await forwardUpload(upload(PATH, { cookie: "better-auth.session_token=s; podster-org=org_1", origin: APP, "cf-connecting-ip": "203.0.113.9", "x-podster-org": "org_x", "x-podster-assertion": "forged", "x-podster-caller": "{}", "x-forwarded-for": "1.1.1.1" }), fake, APP);
    const sent = fake.calls.mock.calls[0][1].headers as Headers;
    expect([...sent.keys()].sort()).toEqual(["authorization", "cf-connecting-ip"]);
    expect(sent.get("authorization")).toBe("Bearer upl_x");
    expect(sent.get("cf-connecting-ip")).toBe("203.0.113.9");
  });

  it("adds no authority of its own when there's no token", async () => {
    const fake = gateway();
    await forwardUpload(new Request(`${APP}${PATH}`, { method: "PUT", headers: { cookie: "better-auth.session_token=s" }, body: "x" }), fake, APP);
    expect([...(fake.calls.mock.calls[0][1].headers as Headers).keys()]).toEqual([]);
  });

  it.each(["/api/v1/uploads/ws_1", "/api/v1/uploads/ws_1/obj_1/more", "/api/v1/uploads/ws%2f1/obj_1", "/api/v1/uploads/../agents/x", "/api/v1/workspaces/ws_1/uploads", "/v1/uploads/ws_1/obj_1"])("refuses %s without calling the gateway", async (path) => {
    const fake = gateway();
    const response = await forwardUpload(upload(path), fake, APP);
    expect(response.status).toBe(404);
    expect(fake.calls).not.toHaveBeenCalled();
  });

  it("answers something to try again when the gateway can't be reached", async () => {
    const fake = gateway();
    fake.calls.mockRejectedValue(new Error("Network connection lost"));
    const response = await forwardUpload(upload(), fake, APP);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: { code: "upstream_unavailable", message: "upstream_unavailable" } });
  });

  it("keeps how long a limit asks to wait", async () => {
    const response = await forwardUpload(upload(), gateway(new Response('{"error":{"code":"rate_limited"}}', { status: 429, headers: { "retry-after": "60" } })), APP);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
  });

  it("passes on the gateway's status and body, with none of its other headers, and isn't cached", async () => {
    const response = await forwardUpload(upload(), gateway(new Response('{"error":{"code":"upload_mismatch"}}', { status: 422, headers: { "set-cookie": "a=b" } })), APP);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: { code: "upload_mismatch" } });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
