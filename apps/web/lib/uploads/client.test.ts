import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_UPLOAD_BYTES, uploadFile, type UploadProgress } from "./client";

const TOKEN = `upl_${"a".repeat(64)}`;
const PATH = "/v1/uploads/ws_1/obj_1";

/** Stands in for the browser's XMLHttpRequest, and a test decides how each send ends. */
class FakeRequest {
  static sent: FakeRequest[] = [];
  upload: { onprogress?: (event: { loaded: number }) => void; onload?: () => void } = {};
  headers: Record<string, string> = {};
  method = "";
  url = "";
  body: unknown;
  status = 0;
  responseText = "";
  responseHeaders: Record<string, string> = {};
  onerror?: () => void;
  onabort?: () => void;
  onload?: () => void;
  open(method: string, url: string) {
    Object.assign(this, { method, url });
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: unknown) {
    this.body = body;
    FakeRequest.sent.push(this);
  }
  getResponseHeader(name: string) {
    return this.responseHeaders[name] ?? null;
  }
  abort() {
    this.onabort?.();
  }
  answer(status: number, body: unknown) {
    this.status = status;
    this.responseText = typeof body === "string" ? body : JSON.stringify(body);
    this.onload?.();
  }
}

const file = (content = "some notes", name = "notes.txt") => new File([content], name, { type: "text/plain" });
const sent = async (index = 0) => {
  await vi.waitFor(() => expect(FakeRequest.sent.length).toBeGreaterThan(index));
  return FakeRequest.sent[index];
};

let fetchMock: ReturnType<typeof vi.fn>;
const reserved = () => new Response(JSON.stringify({ id: "obj_1", upload_path: PATH, token: TOKEN }));

beforeEach(() => {
  FakeRequest.sent = [];
  fetchMock = vi.fn(async () => reserved());
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("XMLHttpRequest", FakeRequest);
});
afterEach(() => vi.unstubAllGlobals());

describe("uploadFile", () => {
  it("reserves with the file's name, size and SHA-256, through this host", async () => {
    const done = uploadFile("ws_1", file("abc"));
    (await sent()).answer(200, { id: "obj_1", state: "scanning" });
    await done;
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/v1/workspaces/ws_1/uploads");
    // The well-known SHA-256 of "abc".
    expect(JSON.parse(init.body)).toEqual({ name: "notes.txt", size: 3, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" });
  });

  it("names the task when the file is for a submission, and only then", async () => {
    const done = uploadFile("ws_1", file("abc"), { taskId: "tsk_1" });
    (await sent()).answer(200, { id: "obj_1", state: "scanning" });
    await done;
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ name: "notes.txt", size: 3, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", task_id: "tsk_1" });
  });

  it("sends the file itself to this host, with the token only in its header", async () => {
    const chosen = file();
    const done = uploadFile("ws_1", chosen);
    const request = await sent();
    expect(request.method).toBe("PUT");
    expect(request.url).toBe(`/api${PATH}`);
    expect(request.url).not.toContain(TOKEN);
    expect(request.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(request.body).toBe(chosen);
    request.answer(200, { id: "obj_1", state: "scanning", size: 10, sha256: "x" });
    expect(await done).toEqual({ ok: true, data: { id: "obj_1", state: "scanning", size: 10, sha256: "x" } });
  });

  it("never hands the token back, whatever happens, and leaves it out of storage", async () => {
    const seen: unknown[] = [];
    const done = uploadFile("ws_1", file(), { onProgress: (progress) => seen.push(progress) });
    (await sent()).answer(422, { error: { code: "upload_mismatch" } });
    const result = await done;
    seen.push(result);
    expect(JSON.stringify(seen)).not.toContain(TOKEN);
    expect(JSON.stringify({ ...localStorage })).not.toContain(TOKEN);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(TOKEN);
  });

  it("reports each phase, and doesn't call a full send finished", async () => {
    const seen: UploadProgress[] = [];
    const done = uploadFile("ws_1", file(), { onProgress: (progress) => seen.push(progress) });
    const request = await sent();
    request.upload.onprogress?.({ loaded: 4 });
    request.upload.onprogress?.({ loaded: 10 });
    request.upload.onload?.();
    let settled = false;
    void done.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    request.answer(200, { id: "obj_1" });
    await done;
    expect(seen).toEqual([{ phase: "hashing" }, { phase: "reserving" }, { phase: "sending", sent: 4, total: 10 }, { phase: "sending", sent: 10, total: 10 }, { phase: "storing" }]);
  });

  it("refuses a file that can't fit without reading it", async () => {
    const big = file();
    Object.defineProperty(big, "size", { value: MAX_UPLOAD_BYTES + 1 });
    const arrayBuffer = vi.spyOn(big, "arrayBuffer");
    expect(await uploadFile("ws_1", big)).toEqual({ ok: false, status: 413, code: "file_too_large" });
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lets through a file of exactly the limit's size", async () => {
    const atLimit = file();
    Object.defineProperty(atLimit, "size", { value: MAX_UPLOAD_BYTES });
    const done = uploadFile("ws_1", atLimit);
    (await sent()).answer(200, { id: "obj_1" });
    expect((await done).ok).toBe(true);
  });

  it("says when a file can't be read, and reserves nothing", async () => {
    const gone = file();
    vi.spyOn(gone, "arrayBuffer").mockRejectedValue(new DOMException("gone", "NotFoundError"));
    expect(await uploadFile("ws_1", gone)).toEqual({ ok: false, status: 0, code: "file_unreadable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes on a refused reservation and sends nothing", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { code: "executable_refused" } }), { status: 415 }));
    expect(await uploadFile("ws_1", file("x", "setup.exe"))).toEqual({ ok: false, status: 415, code: "executable_refused" });
    expect(FakeRequest.sent).toEqual([]);
  });

  it.each([
    [502, "storage_unavailable"],
    [502, "upstream_unavailable"],
    [408, "upload_timed_out"],
    [429, "rate_limited"],
  ])("offers a retry with the same reservation after %i %s", async (status, code) => {
    const done = uploadFile("ws_1", file());
    (await sent()).answer(status, { error: { code } });
    const failed = await done;
    if (failed.ok || !failed.retry) throw new Error("expected a retry");
    expect(failed).toMatchObject({ status, code });
    const again = failed.retry();
    const second = await sent(1);
    expect(second.headers.authorization).toBe(`Bearer ${TOKEN}`);
    second.answer(200, { id: "obj_1" });
    expect((await again).ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  describe("when the server asks to wait", () => {
    beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
    afterEach(() => vi.useRealTimers());

    const limited = async (seconds: string, options = {}) => {
      const done = uploadFile("ws_1", file(), options);
      const request = await sent();
      request.responseHeaders["retry-after"] = seconds;
      request.answer(429, { error: { code: "rate_limited" } });
      const failed = await done;
      if (failed.ok || !failed.retry) throw new Error("expected a retry");
      return failed;
    };

    it("waits that long before sending again", async () => {
      const failed = await limited("60");
      expect(failed.retryAfter).toBe(60);
      void failed.retry!();
      await vi.advanceTimersByTimeAsync(59_000);
      expect(FakeRequest.sent).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(FakeRequest.sent).toHaveLength(2);
    });

    it("stops waiting when canceled, and sends nothing", async () => {
      const stop = new AbortController();
      const failed = await limited("60", { signal: stop.signal });
      const again = failed.retry!();
      stop.abort();
      expect(await again).toEqual({ ok: false, status: 0, code: "upload_canceled" });
      expect(FakeRequest.sent).toHaveLength(1);
    });

    it("has a ceiling, and ignores what isn't a number of seconds", async () => {
      expect((await limited("86400")).retryAfter).toBe(300);
      FakeRequest.sent = [];
      expect((await limited("soon")).retryAfter).toBeUndefined();
    });
  });

  it("reports a connection lost while reserving, rather than throwing", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const result = await uploadFile("ws_1", file());
    expect(result).toEqual({ ok: false, status: 0, code: "network_error" });
    expect(FakeRequest.sent).toEqual([]);
  });

  it("offers a retry after a lost connection", async () => {
    const done = uploadFile("ws_1", file());
    (await sent()).onerror?.();
    expect(await done).toMatchObject({ ok: false, status: 0, code: "network_error", retry: expect.any(Function) });
  });

  it.each([
    [422, "upload_mismatch"],
    [404, "upload_not_found"],
    [403, "access_revoked"],
    [409, "invalid_transition"],
    [415, "executable_refused"],
  ])("offers no retry after %i %s", async (status, code) => {
    const done = uploadFile("ws_1", file());
    (await sent()).answer(status, { error: { code } });
    expect(await done).toEqual({ ok: false, status, code });
  });

  it("doesn't take an answer it can't read for success", async () => {
    const done = uploadFile("ws_1", file());
    (await sent()).answer(200, "<html>");
    expect(await done).toEqual({ ok: false, status: 200, code: "error" });
  });

  it("cancels a send in progress", async () => {
    const stop = new AbortController();
    const done = uploadFile("ws_1", file(), { signal: stop.signal });
    await sent();
    stop.abort();
    expect(await done).toEqual({ ok: false, status: 0, code: "upload_canceled" });
  });

  it("does nothing once already canceled", async () => {
    expect(await uploadFile("ws_1", file(), { signal: AbortSignal.abort() })).toEqual({ ok: false, status: 0, code: "upload_canceled" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("won't use the token if canceled before the send", async () => {
    const stop = new AbortController();
    fetchMock.mockImplementation(async () => {
      stop.abort();
      return reserved();
    });
    expect(await uploadFile("ws_1", file(), { signal: stop.signal })).toEqual({ ok: false, status: 0, code: "upload_canceled" });
    expect(FakeRequest.sent).toEqual([]);
  });

  it("escapes the room's ID in the reservation's path", async () => {
    const done = uploadFile("ws/../1", file());
    (await sent()).answer(200, { id: "obj_1" });
    await done;
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/workspaces/ws%2F..%2F1/uploads");
  });
});
