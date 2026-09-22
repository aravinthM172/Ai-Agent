/**
 * Guardrails around Llama 3.3's tool use. In testing, the model repeated
 * tool calls in a loop and saved text it made up (e.g. "Please share your
 * resume…" as the user's resume); these helpers detect and contain that.
 */
import type { ModelMessage, StepResult, ToolSet } from "ai";

// Words that say nothing about a person's experience, so they don't count
// when checking whether a resume summary came from the user's own text.
const FILLER_WORDS = new Set(
  "please paste share your yours resume profile summary save saved actual real compare with this that here job description posting match about skills".split(
    " "
  )
);

/**
 * Fraction of `text`'s meaningful words (4+ letters, not filler) that also
 * appear in `source`. Returns 0 when `text` has no meaningful words.
 */
export function wordOverlap(text: string, source: string): number {
  const words = (s: string) =>
    (s.toLowerCase().match(/[a-z0-9+#.]{4,}/g) ?? []).filter(
      (w) => !FILLER_WORDS.has(w)
    );
  const sourceWords = new Set(words(source));
  const textWords = words(text);
  if (textWords.length === 0) return 0;
  return textWords.filter((w) => sourceWords.has(w)).length / textWords.length;
}

/** True if some identical tool call (name + input) appears more than once. */
export function hasRepeatedToolCall<T extends ToolSet>(steps: StepResult<T>[]) {
  const seen = new Set<string>();
  for (const call of steps.flatMap((s) => s.toolCalls)) {
    const key = `${call.toolName}:${JSON.stringify(call.input)}`;
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

/** One line per tool result from this turn, e.g. `saveJobNote → Saved ...`. */
export function summarizeToolResults<T extends ToolSet>(
  steps: StepResult<T>[]
) {
  return steps
    .flatMap((s) => s.toolResults)
    .map((r) => {
      const output =
        typeof r.output === "string" ? r.output : JSON.stringify(r.output);
      return `- ${r.toolName} → ${output.slice(0, 1500)}`;
    })
    .join("\n");
}

/** The conversation as plain text only: tool calls and tool results removed. */
export function withoutToolParts(messages: ModelMessage[]): ModelMessage[] {
  return messages.flatMap((m): ModelMessage[] => {
    if (m.role === "system") return [m];
    if (m.role === "tool") return [];
    const text =
      typeof m.content === "string"
        ? m.content
        : m.content
            .map((p) => (p.type === "text" ? p.text : ""))
            .join("")
            .trim();
    if (!text) return [];
    return m.role === "user"
      ? [{ role: "user", content: text }]
      : [{ role: "assistant", content: text }];
  });
}
