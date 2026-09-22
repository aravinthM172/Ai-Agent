/**
 * Helpers for talking to Workers AI from this agent.
 */

/** Llama 3.3 on Workers AI, as recommended in the assignment brief. */
export const CHAT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/**
 * Wraps the Workers AI binding to work around two incompatibilities between
 * workers-ai-provider 3.x and the current Workers AI API:
 *
 * 1. Llama 3.3 streams now send every delta twice per SSE chunk: once in
 *    OpenAI-style `choices[0].delta` and again in the legacy top-level
 *    `response` / `tool_calls` fields. The provider reads both, which doubles
 *    text and corrupts streamed tool-call arguments (e.g.
 *    `{"summary": "{"summary": "BackendBackend ...`), so every tool call
 *    fails validation. We drop the legacy fields whenever `choices` is
 *    present, leaving a single copy of each delta.
 * 2. For a step with no active tools the provider sends `tools: []`, which
 *    Workers AI rejects ("`tools` must not be an empty array"). We omit
 *    `tools` / `tool_choice` in that case.
 */
export function fixWorkersAIBinding(ai: Ai): Ai {
  return new Proxy(ai, {
    get(target, prop, receiver) {
      if (prop !== "run") return Reflect.get(target, prop, receiver);
      return async (...args: Parameters<Ai["run"]>) => {
        const inputs = args[1] as Record<string, unknown> | undefined;
        if (Array.isArray(inputs?.tools) && inputs.tools.length === 0) {
          const { tools: _tools, tool_choice: _toolChoice, ...rest } = inputs;
          args[1] = rest as (typeof args)[1];
        }
        const result: unknown = await target.run(...args);
        if (!(result instanceof ReadableStream)) return result;
        return result.pipeThrough(dedupeSSEStream());
      };
    }
  });
}

/**
 * TransformStream over a Workers AI SSE byte stream that removes the legacy
 * `response` / `tool_calls` fields from any chunk that also has `choices`.
 * Exported for tests.
 */
export function dedupeSSEStream() {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(bytes, controller) {
      buffer += decoder.decode(bytes, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        controller.enqueue(encoder.encode(`${dedupeSSELine(line)}\n`));
      }
    },
    flush(controller) {
      if (buffer) controller.enqueue(encoder.encode(dedupeSSELine(buffer)));
    }
  });
}

function dedupeSSELine(line: string) {
  if (!line.startsWith("data: ")) return line;
  try {
    const chunk = JSON.parse(line.slice(6));
    if (!Array.isArray(chunk.choices)) return line;
    delete chunk.response;
    delete chunk.tool_calls;
    return `data: ${JSON.stringify(chunk)}`;
  } catch {
    return line; // e.g. "data: [DONE]"
  }
}

/**
 * Turns a Workers AI / AI Gateway error into a message that is safe and
 * useful to show in the chat. The AI SDK otherwise shows only
 * "An error occurred.", which gives the user nothing to act on.
 */
export function friendlyAIError(error: unknown): string {
  const text = String(
    error instanceof Error
      ? `${error.message} ${String(error.cause ?? "")}`
      : error
  );
  if (/4006|daily free allocation|neurons/i.test(text)) {
    return "The AI model's free daily limit on this Cloudflare account has been reached. It resets at 00:00 UTC (5:30 AM IST). Your saved jobs and resume are safe; please try again after the reset.";
  }
  if (/rate.?limit|429|too many requests/i.test(text)) {
    return "Too many requests right now. Please wait a few seconds and try again.";
  }
  if (/timed? ?out|timeout/i.test(text)) {
    return "The AI model took too long to respond. Please try again.";
  }
  return "Something went wrong while talking to the AI model. Please try again in a moment.";
}
