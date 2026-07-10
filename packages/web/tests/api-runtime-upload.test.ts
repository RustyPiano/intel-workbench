import { afterEach, describe, expect, it, vi } from "vitest";

import { getRuntimeStatus, uploadMaterialsBatch } from "../src/api";

describe("runtime status and batch upload API", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads the non-sensitive runtime status contract", async () => {
    const runtime = {
      ok: true as const,
      devMode: false,
      networkMode: "restricted-cloud" as const,
      modelConfigured: true,
    };
    const fetchMock = vi.fn().mockResolvedValue(Response.json(runtime));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getRuntimeStatus()).resolves.toEqual(runtime);
    expect(fetchMock).toHaveBeenCalledWith("/api/health", { signal: undefined });
  });

  it("sends multiple files in one ingest request so autopilot sees the complete batch", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true, materials: [{ id: "mat-1" }, { id: "mat-2" }] }, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const prepared = vi.fn();

    await uploadMaterialsBatch(
      "case / 1",
      [new File(["alpha"], "a.txt"), new File([new Uint8Array([0, 255, 1])], "证据.bin")],
      prepared,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/cases/case%20%2F%201/materials");
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body)) as { files: Array<{ filename: string; content: string; encoding: string }> };
    expect(body.files).toEqual([
      { filename: "a.txt", content: "YWxwaGE=", encoding: "base64" },
      { filename: "证据.bin", content: "AP8B", encoding: "base64" },
    ]);
    expect(prepared).toHaveBeenCalledTimes(2);
  });

  it("streams an oversized batch with deferred autopilot and settles exactly once", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const requests: Array<{ url: string; headers: Record<string, string>; file: File }> = [];
    class MockXhr {
      status = 201;
      responseText = "";
      upload: { onprogress?: (event: ProgressEvent) => void } = {};
      onload?: () => void;
      onerror?: () => void;
      private url = "";
      private headers: Record<string, string> = {};

      open(_method: string, url: string) {
        this.url = url;
      }

      setRequestHeader(name: string, value: string) {
        this.headers[name] = value;
      }

      send(file: File) {
        requests.push({ url: this.url, headers: this.headers, file });
        this.responseText = JSON.stringify({ ok: true, material: { id: `mat-${requests.length}` } });
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal("XMLHttpRequest", MockXhr);
    const files = [
      { name: "large-a.bin", size: 10 * 1024 * 1024 },
      { name: "large-b.bin", size: 10 * 1024 * 1024 },
    ] as File[];

    await expect(uploadMaterialsBatch("case-1", files)).resolves.toEqual([{ id: "mat-1" }, { id: "mat-2" }]);
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.headers["x-upload-batch"])).toEqual(["defer", "defer"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/cases/case-1/materials/settle", expect.objectContaining({ method: "POST" }));
  });

  it("settles an oversized batch even when a streamed file fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    class FailingXhr {
      status = 500;
      responseText = JSON.stringify({ ok: false, message: "disk full" });
      upload = {};
      onload?: () => void;
      open() { /* test double */ }
      setRequestHeader() { /* test double */ }
      send() { queueMicrotask(() => this.onload?.()); }
    }
    vi.stubGlobal("XMLHttpRequest", FailingXhr);
    const oversized = { name: "large.bin", size: 19 * 1024 * 1024 } as File;

    await expect(uploadMaterialsBatch("case-1", [oversized])).rejects.toThrow("large.bin：disk full");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/cases/case-1/materials/settle", expect.objectContaining({ method: "POST" }));
  });
});
