import type { ModelMessage, StepResult, ToolSet } from "ai";
import { describe, expect, it } from "vitest";
import {
  groundedJobText,
  hasRepeatedToolCall,
  summarizeToolResults,
  withoutToolParts,
  wordOverlap
} from "../src/lib/guardrails";
import { parseRequirements } from "../src/lib/requirements";

describe("wordOverlap (made-up resume detection)", () => {
  const userMessage =
    "Save my resume: Backend engineer with 4 years of experience in TypeScript, Node.js, PostgreSQL, Docker and AWS.";

  it("accepts a summary taken from the user's own words", () => {
    expect(
      wordOverlap(
        "Backend engineer, 4 years, TypeScript, Node.js, PostgreSQL, AWS",
        userMessage
      )
    ).toBeGreaterThanOrEqual(0.5);
  });

  it("rejects placeholder text the model invented", () => {
    // Real examples Llama 3.3 tried to save as the user's resume.
    const pastedTableRow =
      'Paste a job posting + "How do I match up?" Compares the job to your resume and tells you which skills match';
    expect(
      wordOverlap(
        "Please share your resume/profile summary to compare it with the job description.",
        pastedTableRow
      )
    ).toBeLessThan(0.5);
    expect(
      wordOverlap("Please paste your actual resume", pastedTableRow)
    ).toBeLessThan(0.5);
  });
});

// Minimal StepResult stand-ins: the helpers only read toolCalls/toolResults.
function step(
  calls: { toolName: string; input: unknown; output?: unknown }[]
): StepResult<ToolSet> {
  return {
    toolCalls: calls.map(({ toolName, input }) => ({ toolName, input })),
    toolResults: calls.map(({ toolName, output }) => ({ toolName, output }))
  } as unknown as StepResult<ToolSet>;
}

describe("groundedJobText (model's copy of a pasted job)", () => {
  const userMessage =
    "Analyze this job posting: Stripe, Senior Backend Engineer. Requirements: 5+ years of backend experience, Go or TypeScript, PostgreSQL, Kubernetes, AWS.";

  it("keeps the model's text when it is an exact excerpt", () => {
    const excerpt =
      "Requirements: 5+ years of backend experience, Go or TypeScript, PostgreSQL, Kubernetes, AWS.";
    expect(groundedJobText(excerpt, userMessage)).toBe(excerpt);
  });

  it("uses the user's text when the model altered it (real typo from testing)", () => {
    const altered =
      "Requirements: 5+ years of backend experience, Go or Typecript, PostgreSQL, Kubernetes, AWS.";
    expect(groundedJobText(altered, userMessage)).toBe(userMessage);
  });

  it("rejects text that isn't from the user's message", () => {
    expect(
      groundedJobText(
        "Frontend developer role requiring React, Redux and GraphQL expertise.",
        userMessage
      )
    ).toBeNull();
  });
});

describe("hasRepeatedToolCall", () => {
  it("detects the same tool called with the same input", () => {
    const save = { toolName: "saveJobNote", input: { company: "Acme" } };
    expect(hasRepeatedToolCall([step([save])])).toBe(false);
    expect(hasRepeatedToolCall([step([save]), step([save])])).toBe(true);
  });

  it("allows the same tool with different input", () => {
    expect(
      hasRepeatedToolCall([
        step([{ toolName: "saveJobNote", input: { company: "Acme" } }]),
        step([{ toolName: "saveJobNote", input: { company: "Globex" } }])
      ])
    ).toBe(false);
  });
});

describe("summarizeToolResults", () => {
  it("renders one line per result", () => {
    expect(
      summarizeToolResults([
        step([
          { toolName: "saveJobNote", input: {}, output: "Saved Acme." },
          { toolName: "listJobNotes", input: {}, output: [{ id: "1" }] }
        ])
      ])
    ).toBe('- saveJobNote → Saved Acme.\n- listJobNotes → [{"id":"1"}]');
  });
});

describe("withoutToolParts", () => {
  it("keeps only plain text, dropping tool calls and results", () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "Save Acme" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Saving." },
          {
            type: "tool-call",
            toolCallId: "1",
            toolName: "saveJobNote",
            input: {}
          }
        ]
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "1",
            toolName: "saveJobNote",
            output: { type: "text", value: "ok" }
          }
        ]
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "2",
            toolName: "saveJobNote",
            input: {}
          }
        ]
      }
    ];
    expect(withoutToolParts(messages)).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "Save Acme" },
      { role: "assistant", content: "Saving." }
    ]);
  });
});

describe("parseRequirements (LLM JSON-mode output)", () => {
  const valid = {
    requiredSkills: ["TypeScript"],
    niceToHaveSkills: [],
    minYearsExperience: 3,
    seniority: "mid",
    summary: "Backend role."
  };

  it("accepts an object, a JSON string, or OpenAI-style choices", () => {
    expect(parseRequirements({ response: valid })).toEqual(valid);
    expect(
      parseRequirements({ response: `Here you go:\n${JSON.stringify(valid)}` })
    ).toEqual(valid);
    expect(
      parseRequirements({
        choices: [{ message: { content: JSON.stringify(valid) } }]
      })
    ).toEqual(valid);
  });

  it("fills optional fields with defaults", () => {
    expect(parseRequirements({ response: { requiredSkills: ["Go"] } })).toEqual(
      {
        requiredSkills: ["Go"],
        niceToHaveSkills: [],
        minYearsExperience: null,
        seniority: null,
        summary: ""
      }
    );
  });

  it("throws on malformed output so the Workflow step retries", () => {
    expect(() => parseRequirements({ response: "sorry, I can't" })).toThrow();
    expect(() =>
      parseRequirements({ response: { requiredSkills: "TypeScript" } })
    ).toThrow();
  });
});
