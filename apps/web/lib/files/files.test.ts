import { describe, expect, it } from "vitest";
import { downloadHref, fileSize, fileState, type StoredFile } from "./files";

const stored = (over: Partial<StoredFile> = {}): StoredFile => ({ state: "ready", download_path: "/v1/files/ws_1/obj_1", ...over });

describe("shared file display", () => {
  it("writes sizes in the decimal units the limits use", () => {
    expect(fileSize(1)).toBe("1 byte");
    expect(fileSize(999)).toBe("999 bytes");
    expect(fileSize(2_400_000)).toBe("2.4 MB");
    expect(fileSize(100_000_000)).toBe("100 MB");
  });

  it("never calls an unknown or missing state Ready, and never says safe", () => {
    expect(fileState("quarantined").label).toBe("Unavailable");
    expect(fileState(null).label).toBe("Unavailable");
    expect(fileState("constructor").label).toBe("Unavailable");
    expect(fileState("failed").label).toBe("Scan failed");
    expect(JSON.stringify(["uploading", "scanning", "ready", "blocked", "failed", "removed"].map(fileState))).not.toMatch(/safe|clean|virus-free/i);
  });

  it("links only the API's own path for a ready file, through this host", () => {
    expect(downloadHref(stored())).toBe("/api/v1/files/ws_1/obj_1");
    expect(downloadHref(stored({ state: "scanning" }))).toBeNull();
    expect(downloadHref(stored({ download_path: null }))).toBeNull();
    for (const path of ["https://evil.example/x", "/v1/files/ws_1/../admin", "/v1/files/ws_1/obj_1?x=1", "//evil.example/v1/files/a/b", "javascript:alert(1)"]) expect(downloadHref(stored({ download_path: path }))).toBeNull();
  });
});
