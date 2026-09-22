/**
 * Uses the LLM to pull structured requirements out of a job description.
 * The result is validated with zod; anything malformed throws, so the calling
 * Workflow step retries instead of storing garbage.
 */
import { z } from "zod";
import type { JobRequirements } from "./matching";
import { CHAT_MODEL } from "./workers-ai";

export const jobRequirementsSchema = z.object({
  requiredSkills: z.array(z.string()).max(30),
  niceToHaveSkills: z.array(z.string()).max(30).default([]),
  minYearsExperience: z.number().int().min(0).max(40).nullable().default(null),
  seniority: z.string().nullable().default(null),
  summary: z.string().max(600).default("")
});

// JSON Schema for Workers AI's JSON mode, mirroring jobRequirementsSchema.
const RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    type: "object",
    properties: {
      requiredSkills: { type: "array", items: { type: "string" } },
      niceToHaveSkills: { type: "array", items: { type: "string" } },
      minYearsExperience: { type: ["integer", "null"] },
      seniority: { type: ["string", "null"] },
      summary: { type: "string" }
    },
    required: [
      "requiredSkills",
      "niceToHaveSkills",
      "minYearsExperience",
      "seniority",
      "summary"
    ]
  }
} as const;

const SYSTEM_PROMPT = `You extract structured requirements from a job description.
Return JSON only, matching the schema.
- requiredSkills: concrete technical skills/tools the job requires (e.g. "TypeScript", "PostgreSQL", "Kubernetes"). One skill per item, short names, no sentences. If the job accepts alternatives, write them as one item joined by " or " (e.g. "Go or TypeScript").
- niceToHaveSkills: skills listed as preferred/bonus/nice to have.
- minYearsExperience: the minimum years of experience required as an integer, or null if not stated.
- seniority: e.g. "junior", "mid", "senior", "staff", or null.
- summary: one or two sentences describing the role.
Only include what the text actually says. Do not invent requirements.`;

/** Asks Llama 3.3 (JSON mode) for the job's requirements and validates them. */
export async function extractRequirements(
  ai: Ai,
  jobDescription: string,
  options?: AiOptions
): Promise<JobRequirements> {
  const result = (await ai.run(
    CHAT_MODEL,
    {
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: jobDescription.slice(0, 12000) }
      ],
      response_format: RESPONSE_FORMAT,
      temperature: 0,
      max_tokens: 800
    } as never,
    options
  )) as unknown;
  return parseRequirements(result);
}

/**
 * Validates a Workers AI JSON-mode result. Depending on the model/API
 * version, the JSON arrives as an object in `response`, as a string in
 * `response`, or in OpenAI-style `choices[0].message.content`.
 */
export function parseRequirements(result: unknown): JobRequirements {
  const r = result as {
    response?: unknown;
    choices?: { message?: { content?: unknown } }[];
  };
  let payload = r?.response ?? r?.choices?.[0]?.message?.content;
  if (typeof payload === "string") {
    const json = payload.match(/\{[\s\S]*\}/)?.[0];
    if (!json) throw new Error("Model did not return JSON requirements");
    payload = JSON.parse(json);
  }
  return jobRequirementsSchema.parse(payload);
}
