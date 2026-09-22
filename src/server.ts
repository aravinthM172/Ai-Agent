import { createWorkersAI } from "workers-ai-provider";
import { callable, routeAgentRequest, type Schedule } from "agents";
import { getSchedulePrompt, scheduleSchema } from "agents/schedule";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  streamText,
  tool,
  type ModelMessage,
  type StepResult,
  type ToolSet
} from "ai";
import { z } from "zod";

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
function fixWorkersAIBinding(ai: Ai): Ai {
  const fixLine = (line: string) => {
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
  };

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

        const decoder = new TextDecoder();
        const encoder = new TextEncoder();
        let buffer = "";
        return result.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(bytes, controller) {
              buffer += decoder.decode(bytes, { stream: true });
              const lines = buffer.split("\n");
              buffer = lines.pop() ?? "";
              for (const line of lines) {
                controller.enqueue(encoder.encode(`${fixLine(line)}\n`));
              }
            },
            flush(controller) {
              if (buffer) controller.enqueue(encoder.encode(fixLine(buffer)));
            }
          })
        );
      };
    }
  });
}

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
function wordOverlap(text: string, source: string): number {
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
function hasRepeatedToolCall<T extends ToolSet>(steps: StepResult<T>[]) {
  const seen = new Set<string>();
  for (const call of steps.flatMap((s) => s.toolCalls)) {
    const key = `${call.toolName}:${JSON.stringify(call.input)}`;
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

/** One line per tool result from this turn, e.g. `saveJobNote → Saved ...`. */
function summarizeToolResults<T extends ToolSet>(steps: StepResult<T>[]) {
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
function withoutToolParts(messages: ModelMessage[]): ModelMessage[] {
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

/**
 * JobSearchCopilot — an AI agent that helps track job applications and
 * compare job descriptions against a saved resume/profile.
 *
 * Components (per the assignment brief):
 *  - LLM: Llama 3.3 on Workers AI
 *  - Workflow / coordination: this Durable Object (Agent) + tool calls,
 *    plus the Agents SDK's built-in task scheduler
 *  - User input: chat, served from a Vite/React frontend on Cloudflare
 *    Pages/Workers assets
 *  - Memory / state: SQLite storage inside the Durable Object (job notes
 *    + resume profile), persisted across sessions and reloads
 */
export class JobSearchCopilot extends AIChatAgent<Env> {
  maxPersistedMessages = 100;
  chatRecovery = true;
  waitForMcpConnections = true;

  onStart() {
    // Create the tables this agent needs, in addition to the built-in
    // chat history / schedule tables the base Agent class already manages.
    this.sql`
      CREATE TABLE IF NOT EXISTS job_notes (
        id TEXT PRIMARY KEY,
        company TEXT,
        role TEXT,
        status TEXT DEFAULT 'saved',
        notes TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS resume_profile (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        summary TEXT
      )
    `;

    this.mcp.configureOAuthCallback({
      customHandler: (result) => {
        if (result.authSuccess) {
          return new Response("<script>window.close();</script>", {
            headers: { "content-type": "text/html" },
            status: 200
          });
        }
        return new Response(
          `Authentication Failed: ${result.authError || "Unknown error"}`,
          { headers: { "content-type": "text/plain" }, status: 400 }
        );
      }
    });
  }

  @callable()
  async addServer(name: string, url: string) {
    return await this.addMcpServer(name, url);
  }

  @callable()
  async removeServer(serverId: string) {
    await this.removeMcpServer(serverId);
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const mcpTools = this.mcp.getAITools();
    const workersai = createWorkersAI({
      binding: fixWorkersAIBinding(this.env.AI)
    });

    const lastUserText =
      [...this.messages]
        .reverse()
        .find((m) => m.role === "user")
        ?.parts.map((p) => (p.type === "text" ? p.text : ""))
        .join(" ") ?? "";

    const savedProfile = this.sql<{ summary: string }>`
      SELECT summary FROM resume_profile WHERE id = 1
    `[0]?.summary;

    const modelMessages = pruneMessages({
      messages: await convertToModelMessages(this.messages),
      toolCalls: "before-last-2-messages",
      reasoning: "before-last-message"
    });

    const result = streamText({
      // Llama 3.3 on Workers AI, as recommended in the assignment brief.
      model: workersai("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
        sessionAffinity: this.sessionAffinity
      }),
      system: `You are Job Search Copilot, an assistant that helps a candidate manage their job search.

You can:
- save a job posting/application as a note (saveJobNote), with company, role, status, and any notes
- list saved job notes (listJobNotes), optionally filtered by status
- update the status of a saved job (updateJobStatus) — e.g. "applied", "interviewing", "offer", "rejected"
- save or update the user's resume/profile summary (saveResumeProfile) so you can refer back to it later
- compare a pasted job description against the saved resume profile (compareJobToProfile) and point out
  matching skills and clear gaps — be honest and specific, don't inflate the match
- check the user's timezone and schedule reminders/follow-ups (scheduleTask)

${savedProfile ? `The user's saved resume/profile summary is:\n${savedProfile}` : "The user has not saved a resume/profile summary yet. If they paste one, offer to save it with saveResumeProfile."}

${getSchedulePrompt({ date: new Date() })}

Rules for using tools:
- Only save information the user actually gave you. Never invent, guess, or save placeholder text as a
  resume, job, or note. If something you need is missing (e.g. no resume saved, or no real job
  description pasted), ask the user for it in plain text instead of calling a tool.
- Call each tool at most once per user message, then answer the user in text.

Keep responses concise and concrete. When comparing a job description to the resume, structure your
answer as: matching keywords/skills, missing/weak areas, and one honest recommendation — no filler.`,
      messages: modelMessages,
      tools: {
        ...mcpTools,

        saveJobNote: tool({
          description:
            "Save a job posting or application as a note, so it can be recalled later.",
          inputSchema: z.object({
            company: z.string().describe("Company name"),
            role: z.string().describe("Job title / role"),
            status: z
              .enum(["saved", "applied", "interviewing", "offer", "rejected"])
              .optional()
              .describe('Defaults to "saved"'),
            notes: z
              .string()
              .optional()
              .describe("Any extra notes, e.g. JD summary or link")
          }),
          // Save tools return a plain-English confirmation rather than a JSON
          // flag like { saved: true }: with JSON results Llama 3.3 often
          // doesn't treat the action as done and calls the tool again.
          execute: async ({ company, role, status = "saved", notes }) => {
            // Saving the same company + role again updates the existing note
            // instead of creating a duplicate (Llama sometimes repeats calls).
            const existing = this.sql<{ id: string }>`
              SELECT id FROM job_notes
              WHERE lower(company) = lower(${company}) AND lower(role) = lower(${role})
            `[0];
            if (existing) {
              this.sql`
                UPDATE job_notes
                SET status = ${status}, notes = COALESCE(${notes ?? null}, notes)
                WHERE id = ${existing.id}
              `;
              return `Updated the existing note for ${company} – ${role} (status: ${status}, id: ${existing.id}).`;
            }
            const id = crypto.randomUUID();
            this.sql`
              INSERT INTO job_notes (id, company, role, status, notes)
              VALUES (${id}, ${company}, ${role}, ${status}, ${notes ?? null})
            `;
            return `Saved ${company} – ${role} (status: ${status}, id: ${id}).`;
          }
        }),

        listJobNotes: tool({
          description: "List saved job notes, optionally filtered by status.",
          inputSchema: z.object({
            status: z
              .enum(["saved", "applied", "interviewing", "offer", "rejected"])
              .optional()
          }),
          execute: async ({ status }) => {
            const rows = status
              ? this
                  .sql`SELECT * FROM job_notes WHERE status = ${status} ORDER BY created_at DESC`
              : this.sql`SELECT * FROM job_notes ORDER BY created_at DESC`;
            return rows.length ? rows : "No saved job notes yet.";
          }
        }),

        updateJobStatus: tool({
          description: "Update the status of a previously saved job note.",
          inputSchema: z.object({
            id: z.string().describe("The job note ID"),
            status: z.enum([
              "saved",
              "applied",
              "interviewing",
              "offer",
              "rejected"
            ])
          }),
          execute: async ({ id, status }) => {
            const job = this.sql<{ company: string; role: string }>`
              SELECT company, role FROM job_notes WHERE id = ${id}
            `[0];
            if (!job) {
              return `No saved job with id ${id}. Use listJobNotes to find the right id.`;
            }
            this.sql`UPDATE job_notes SET status = ${status} WHERE id = ${id}`;
            return `Updated ${job.company} – ${job.role} to "${status}".`;
          }
        }),

        saveResumeProfile: tool({
          description:
            "Save or replace the user's resume/profile summary, used later to compare against job descriptions.",
          inputSchema: z.object({
            summary: z
              .string()
              .describe(
                "A concise summary of the user's skills, experience, and background"
              )
          }),
          execute: async ({ summary }) => {
            // Refuse summaries the model made up: most of the summary's words
            // must come from what the user just wrote.
            if (wordOverlap(summary, lastUserText) < 0.5) {
              return "Not saved: this doesn't look like the user's own resume text. Ask the user to paste their resume or a summary of their experience.";
            }
            this.sql`
              INSERT INTO resume_profile (id, summary) VALUES (1, ${summary})
              ON CONFLICT(id) DO UPDATE SET summary = excluded.summary
            `;
            return "Resume profile saved.";
          }
        }),

        compareJobToProfile: tool({
          description:
            "Compare a pasted job description against the saved resume/profile summary.",
          inputSchema: z.object({
            jobDescription: z.string().describe("The job description text")
          }),
          execute: async ({ jobDescription }) => {
            const profile = this.sql<{ summary: string }>`
              SELECT summary FROM resume_profile WHERE id = 1
            `[0]?.summary;
            if (!profile) {
              return "No resume/profile summary saved yet. Do not call saveResumeProfile now — ask the user to paste their resume first.";
            }
            if (jobDescription.trim().length < 60) {
              return "No real job description was provided. Ask the user to paste the full job posting text.";
            }
            // Hand both texts back to the model turn — the LLM does the
            // actual comparison/reasoning in its response, this tool just
            // makes sure both pieces of context are present together.
            return { profile, jobDescription };
          }
        }),

        getUserTimezone: tool({
          description:
            "Get the user's timezone from their browser. Use this when scheduling reminders in local time.",
          inputSchema: z.object({})
        }),

        scheduleTask: tool({
          description:
            "Schedule a reminder or follow-up (e.g. 'follow up on the Acme application in 3 days').",
          inputSchema: scheduleSchema,
          execute: async ({ when, description }) => {
            if (when.type === "no-schedule") {
              return "Not a valid schedule input";
            }
            const input =
              when.type === "scheduled"
                ? when.date
                : when.type === "delayed"
                  ? when.delayInSeconds
                  : when.type === "cron"
                    ? when.cron
                    : null;
            if (!input) return "Invalid schedule type";
            try {
              this.schedule(input, "executeTask", description, {
                idempotent: true
              });
              return `Task scheduled: "${description}" (${when.type}: ${input})`;
            } catch (error) {
              return `Error scheduling task: ${error}`;
            }
          }
        }),

        getScheduledTasks: tool({
          description: "List all reminders/follow-ups that have been scheduled",
          inputSchema: z.object({}),
          execute: async () => {
            const tasks = this.getSchedules();
            return tasks.length > 0 ? tasks : "No scheduled tasks found.";
          }
        }),

        cancelScheduledTask: tool({
          description: "Cancel a scheduled reminder/follow-up by its ID",
          inputSchema: z.object({
            taskId: z.string().describe("The ID of the task to cancel")
          }),
          execute: async ({ taskId }) => {
            try {
              this.cancelSchedule(taskId);
              return `Task ${taskId} cancelled.`;
            } catch (error) {
              return `Error cancelling task: ${error}`;
            }
          }
        })
      },
      // Llama 3.3 can get stuck calling tools over and over. Once it repeats
      // a call or has made 3 rounds of tool calls, run one last step with no
      // tools and no tool-call history (just a plain-text summary of what the
      // tools returned), so it has to answer in text. Simply disabling tools
      // isn't enough: with tool calls in the history Llama keeps imitating
      // them, or prints them as raw JSON.
      prepareStep: ({ steps }) => {
        const toolRounds = steps.filter((s) => s.toolCalls.length > 0).length;
        if (!hasRepeatedToolCall(steps) && toolRounds < 3) return {};
        return {
          activeTools: [],
          toolChoice: "none",
          messages: [
            ...withoutToolParts(modelMessages),
            {
              role: "user",
              content: `(Automatic note: these actions already ran for my last message:\n${summarizeToolResults(steps)}\n\nReply to me now in plain text based on these results. Do not call any tools and do not output JSON. If you need information from me, ask for it.)`
            }
          ]
        };
      },
      stopWhen: stepCountIs(6),
      // workers-ai-provider defaults to 256 tokens, which cuts off longer
      // answers such as job/resume comparisons mid-sentence.
      maxOutputTokens: 1024,
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }

  async executeTask(description: string, _task: Schedule<string>) {
    console.log(`Executing scheduled task: ${description}`);
    this.broadcast(
      JSON.stringify({
        type: "scheduled-task",
        description,
        timestamp: new Date().toISOString()
      })
    );
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
