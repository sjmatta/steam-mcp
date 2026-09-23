import { vi } from "vitest";

export interface StubbedCall {
  url: string;
}

export interface FetchStub {
  calls: StubbedCall[];
  /** Number of requests whose URL contains the given fragment. */
  countMatching(fragment: string): number;
}

type Responder = (url: string) => {
  status?: number;
  body?: unknown;
  /** Raw text, used to simulate non-JSON responses. */
  text?: string;
  throws?: boolean;
} | null;

/**
 * Replaces global fetch with a scripted responder.
 *
 * Web tests must never touch the network: the store endpoints are rate limited
 * to roughly 200 requests per 5 minutes per IP, and a test suite that hits them
 * would get the developer's address throttled.
 */
export function stubFetch(responder: Responder): FetchStub {
  const calls: StubbedCall[] = [];

  vi.stubGlobal("fetch", async (input: unknown) => {
    const url = String(input);
    calls.push({ url });

    const reply = responder(url);
    if (!reply) throw new Error(`unexpected request: ${url}`);
    if (reply.throws) throw new Error("network down");

    const status = reply.status ?? 200;
    const text = reply.text ?? JSON.stringify(reply.body ?? null);
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() {
        return JSON.parse(text);
      },
      async text() {
        return text;
      },
    };
  });

  return {
    calls,
    countMatching: (fragment: string) => calls.filter((c) => c.url.includes(fragment)).length,
  };
}
