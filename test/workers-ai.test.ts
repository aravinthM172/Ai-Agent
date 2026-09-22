import { describe, expect, it } from "vitest";
import {
  dedupeSSEStream,
  fixWorkersAIBinding,
  friendlyAIError
} from "../src/lib/workers-ai";

/** Pipes SSE text through the dedupe transform, split into awkward chunks. */
async function dedupe(sse: string, chunkSize = 7): Promise<string> {
  const bytes = new TextEncoder().encode(sse);
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      // Split mid-line to prove lines are buffered across chunks.
      for (let i = 0; i < bytes.length; i += chunkSize) {
        controller.enqueue(bytes.slice(i, i + chunkSize));
      }
      controller.close();
    }
  });
  return new Response(input.pipeThrough(dedupeSSEStream())).text();
}

// A real chunk shape from Workers AI (Llama 3.3), carrying the same tool-call
// argument fragment in both choices[0].delta and the legacy top-level field.
const DUPLICATED_CHUNK = {
  choices: [
    {
      delta: {
        tool_calls: [{ function: { arguments: '{"summary": "' }, index: 0 }]
      },
      index: 0
    }
  ],
  response: "",
  tool_calls: [{ arguments: '{"summary": "' }]
};

describe("dedupeSSEStream", () => {
  it("drops legacy fields when choices is present", async () => {
    const out = await dedupe(`data: ${JSON.stringify(DUPLICATED_CHUNK)}\n\n`);
    const parsed = JSON.parse(out.trim().slice("data: ".length));
    expect(parsed.tool_calls).toBeUndefined();
    expect(parsed.response).toBeUndefined();
    expect(parsed.choices[0].delta.tool_calls[0].function.arguments).toBe(
      '{"summary": "'
    );
  });

  it("leaves legacy-only chunks and [DONE] untouched", async () => {
    const legacy = `data: ${JSON.stringify({ response: "Hi" })}`;
    const out = await dedupe(`${legacy}\n\ndata: [DONE]\n\n`);
    expect(out).toBe(`${legacy}\n\ndata: [DONE]\n\n`);
  });
});

describe("fixWorkersAIBinding", () => {
  it("omits an empty tools array (rejected by Workers AI)", async () => {
    let received: Record<string, unknown> | undefined;
    const fakeAI = {
      run: async (_model: string, inputs: Record<string, unknown>) => {
        received = inputs;
        return { response: "ok" };
      }
    } as unknown as Ai;

    await fixWorkersAIBinding(fakeAI).run(
      "model" as never,
      {
        messages: [],
        tools: [],
        tool_choice: "none"
      } as never
    );
    expect(received).toEqual({ messages: [] });
  });

  it("passes non-empty tools and other properties through", async () => {
    let received: Record<string, unknown> | undefined;
    const fakeAI = {
      run: async (_model: string, inputs: Record<string, unknown>) => {
        received = inputs;
        return { response: "ok" };
      },
      gateway: () => "gateway-object"
    } as unknown as Ai;

    const fixed = fixWorkersAIBinding(fakeAI);
    const tools = [{ type: "function", function: { name: "x" } }];
    await fixed.run("model" as never, { messages: [], tools } as never);
    expect(received?.tools).toEqual(tools);
    expect((fixed as unknown as { gateway: () => string }).gateway()).toBe(
      "gateway-object"
    );
  });
});

describe("friendlyAIError", () => {
  it("explains the daily free limit (Workers AI error 4006)", () => {
    const message = friendlyAIError(
      new Error(
        "4006: you have used up your daily free allocation of 10,000 neurons"
      )
    );
    expect(message).toMatch(/free daily limit/);
    expect(message).toMatch(/00:00 UTC/);
  });

  it("recognises rate limits and timeouts", () => {
    expect(friendlyAIError(new Error("429 Too Many Requests"))).toMatch(
      /Too many requests/
    );
    expect(friendlyAIError("Request timed out")).toMatch(/too long/);
  });

  it("never leaks raw error details", () => {
    const message = friendlyAIError(
      new Error("internal error; reference = abc123 secret-stack-trace")
    );
    expect(message).not.toMatch(/abc123|secret/);
  });
});
