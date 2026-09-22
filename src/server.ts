import { createWorkersAI } from "workers-ai-provider";
import { callable, routeAgentRequest, type Schedule } from "agents";
import { getSchedulePrompt, scheduleSchema } from "agents/schedule";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  streamText,
  tool
} from "ai";
import { z } from "zod";

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
    const workersai = createWorkersAI({ binding: this.env.AI });

    const savedProfile = this.sql<{ summary: string }>`
      SELECT summary FROM resume_profile WHERE id = 1
    `[0]?.summary;

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

Keep responses concise and concrete. When comparing a job description to the resume, structure your
answer as: matching keywords/skills, missing/weak areas, and one honest recommendation — no filler.`,
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages",
        reasoning: "before-last-message"
      }),
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
              .default("saved"),
            notes: z
              .string()
              .optional()
              .describe("Any extra notes, e.g. JD summary or link")
          }),
          execute: async ({ company, role, status, notes }) => {
            const id = crypto.randomUUID();
            this.sql`
              INSERT INTO job_notes (id, company, role, status, notes)
              VALUES (${id}, ${company}, ${role}, ${status ?? "saved"}, ${notes ?? null})
            `;
            return { saved: true, id, company, role, status };
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
              ? this.sql`SELECT * FROM job_notes WHERE status = ${status} ORDER BY created_at DESC`
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
            this.sql`UPDATE job_notes SET status = ${status} WHERE id = ${id}`;
            return { updated: true, id, status };
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
            this.sql`
              INSERT INTO resume_profile (id, summary) VALUES (1, ${summary})
              ON CONFLICT(id) DO UPDATE SET summary = excluded.summary
            `;
            return { saved: true };
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
              return "No resume/profile summary saved yet. Ask the user to share one, then save it with saveResumeProfile before comparing.";
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
      stopWhen: stepCountIs(20),
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
