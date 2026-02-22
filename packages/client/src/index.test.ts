import { describe, expect, it } from "bun:test";

import { BirdhouseClient, buildAuthHeaders, joinUrl } from "./index";

describe("joinUrl", () => {
  it("joins base and path safely", () => {
    expect(joinUrl("https://example.com/", "/v1/chat.stream")).toBe("https://example.com/v1/chat.stream");
    expect(joinUrl("https://example.com", "v1/health")).toBe("https://example.com/v1/health");
  });
});

describe("buildAuthHeaders", () => {
  it("returns empty object for none", () => {
    expect(buildAuthHeaders({ type: "none" })).toEqual({});
  });

  it("builds bearer auth header", () => {
    expect(buildAuthHeaders({ type: "bearer", token: "abc" })).toEqual({ Authorization: "Bearer abc" });
  });

  it("builds basic auth header", () => {
    expect(buildAuthHeaders({ type: "basic", username: "user", password: "pass" })).toEqual({
      Authorization: "Basic dXNlcjpwYXNz"
    });
  });
});

describe("discoverProvider", () => {
  it("uses /v1/providers/default when available", async () => {
    const client = new BirdhouseClient({
      fetchFn: async (url) => {
        if (String(url).endsWith("/v1/providers/default")) {
          return new Response(JSON.stringify({ kind: "openclaw" }), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }

        return new Response("not found", { status: 404 });
      }
    });

    await expect(
      client.discoverProvider({
        baseUrl: "https://example.com",
        auth: { type: "none" }
      })
    ).resolves.toBe("openclaw");
  });

  it("falls back to /v1/providers/capabilities", async () => {
    const client = new BirdhouseClient({
      fetchFn: async (url) => {
        if (String(url).endsWith("/v1/providers/default")) {
          return new Response("not found", { status: 404 });
        }

        if (String(url).endsWith("/v1/providers/capabilities")) {
          return new Response(
            JSON.stringify({
              capabilities: [
                { kind: "openclaw", supportsStreaming: true, supportsAttachments: true, supportsAsync: true },
                { kind: "ai-sdk", supportsStreaming: true, supportsAttachments: true, supportsAsync: true }
              ]
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" }
            }
          );
        }

        return new Response("not found", { status: 404 });
      }
    });

    await expect(
      client.discoverProvider({
        baseUrl: "https://example.com",
        auth: { type: "none" }
      })
    ).resolves.toBe("ai-sdk");
  });

  it("falls back to terminal-cli when capabilities are empty", async () => {
    const client = new BirdhouseClient({
      fetchFn: async (url) => {
        if (String(url).endsWith("/v1/providers/default")) {
          return new Response("not found", { status: 404 });
        }

        if (String(url).endsWith("/v1/providers/capabilities")) {
          return new Response(JSON.stringify({ capabilities: [] }), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }

        return new Response("not found", { status: 404 });
      }
    });

    await expect(
      client.discoverProvider({
        baseUrl: "https://example.com",
        auth: { type: "none" }
      })
    ).resolves.toBe("terminal-cli");
  });

  it("falls back to terminal-cli when capabilities endpoint is unavailable", async () => {
    const client = new BirdhouseClient({
      fetchFn: async (url) => {
        if (String(url).endsWith("/v1/providers/default")) {
          return new Response("not found", { status: 404 });
        }

        if (String(url).endsWith("/v1/providers/capabilities")) {
          return new Response("unavailable", { status: 503 });
        }

        return new Response("not found", { status: 404 });
      }
    });

    await expect(
      client.discoverProvider({
        baseUrl: "https://example.com",
        auth: { type: "none" }
      })
    ).resolves.toBe("terminal-cli");
  });
});
