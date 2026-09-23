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
import {
  groundedJobText,
  hasRepeatedToolCall,
  summarizeToolResults,
  withoutToolParts,
  wordOverlap
} from "./lib/guardrails";
import type { JobRequirements, MatchResult } from "./lib/matching";
import { chatModel } from "./lib/llm";
import { friendlyAIError } from "./lib/workers-ai";
import type {
  JobAnalysisParams,
  JobAnalysisResult
} from "./workflows/job-analysis";

export { JobAnalysisWorkflow } from "./workflows/job-analysis";

export const JOB_STATUSES = [
  "saved",
  "applied",
  "interviewing",
  "offer",
  "rejected"
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export type JobNote = {
  id: string;
  company: string;
  role: string;
  status: JobStatus;
  notes: string | null;
  match_score: number | null;
  created_at: string;
};

/**
 * JobSearchCopilot — an AI agent that helps track job applications and
 * compare job descriptions against a saved resume/profile.
 *
 * One instance (a Durable Object) exists per user: the browser picks a random
 * ID and connects to /agents/job-search-copilot/<id>, so each user gets their
 * own isolated SQLite database, chat history, and scheduled reminders.
 *
 * Components (per the assignment brief):
 *  - LLM: Llama 3.3 on Workers AI, via AI Gateway
 *  - Workflow / coordination: this Durable Object runs the chat/tool loop;
 *    JobAnalysisWorkflow (Cloudflare Workflows) runs durable background
 *    analysis; the Agents SDK scheduler runs follow-up reminders
 *  - User input: chat, served from a Vite/React frontend on Workers assets
 *  - Memory / state: SQLite inside the Durable Object (job notes, match
 *    analyses, resume profile), persisted across sessions and deploys
 */
export class JobSearchCopilot extends AIChatAgent<Env> {
  maxPersistedMessages = 100;
  chatRecovery = true;
  waitForMcpConnections = true;

  onStart() {
    // Tables for this agent, alongside the chat history / schedule tables the
    // base Agent class already manages.
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
    // v2: match analysis columns. SQLite has no ADD COLUMN IF NOT EXISTS, so
    // check the existing columns first (instances created before v2 lack them).
    const columns = this.sql<{
      name: string;
    }>`PRAGMA table_info(job_notes)`.map((c) => c.name);
    if (!columns.includes("match_score")) {
      this.sql`ALTER TABLE job_notes ADD COLUMN match_score INTEGER`;
      this.sql`ALTER TABLE job_notes ADD COLUMN analysis TEXT`;
    }

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

  // ---------------------------------------------------------------------------
  // Data access. Used by the chat tools, by JobAnalysisWorkflow over RPC, and
  // directly by the tests.
  // ---------------------------------------------------------------------------

  /**
   * Saves a job, or updates it if the same company + role already exists
   * (case-insensitive), so repeated saves never create duplicates.
   */
  saveJob(input: {
    company: string;
    role: string;
    status?: JobStatus;
    notes?: string;
  }): { id: string; updated: boolean } {
    const { company, role, status = "saved", notes } = input;
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
      return { id: existing.id, updated: true };
    }
    const id = crypto.randomUUID();
    this.sql`
      INSERT INTO job_notes (id, company, role, status, notes)
      VALUES (${id}, ${company}, ${role}, ${status}, ${notes ?? null})
    `;
    return { id, updated: false };
  }

  listJobs(status?: JobStatus): JobNote[] {
    return status
      ? this.sql<JobNote>`
          SELECT id, company, role, status, notes, match_score, created_at
          FROM job_notes WHERE status = ${status} ORDER BY created_at DESC`
      : this.sql<JobNote>`
          SELECT id, company, role, status, notes, match_score, created_at
          FROM job_notes ORDER BY created_at DESC`;
  }

  /** Returns the updated job, or null if no job has this id. */
  setJobStatus(id: string, status: JobStatus): JobNote | null {
    this.sql`UPDATE job_notes SET status = ${status} WHERE id = ${id}`;
    return (
      this.sql<JobNote>`
        SELECT id, company, role, status, notes, match_score, created_at
        FROM job_notes WHERE id = ${id}`[0] ?? null
    );
  }

  getResumeProfile(): string | null {
    return (
      this.sql<{ summary: string }>`
        SELECT summary FROM resume_profile WHERE id = 1`[0]?.summary ?? null
    );
  }

  saveResumeProfile(summary: string) {
    this.sql`
      INSERT INTO resume_profile (id, summary) VALUES (1, ${summary})
      ON CONFLICT(id) DO UPDATE SET summary = excluded.summary
    `;
  }

  /** Called by JobAnalysisWorkflow once it has scored a job. */
  saveJobAnalysis(
    jobId: string,
    analysis: { requirements: JobRequirements; match: MatchResult }
  ) {
    this.sql`
      UPDATE job_notes
      SET match_score = ${analysis.match.score}, analysis = ${JSON.stringify(analysis)}
      WHERE id = ${jobId}
    `;
  }

  // ---------------------------------------------------------------------------
  // Chat
  // ---------------------------------------------------------------------------

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
    const model = chatModel(this.env, this.sessionAffinity);

    // The user's last few messages, so "save that resume" can refer to text
    // pasted a message or two earlier.
    const recentUserText = this.messages
      .filter((m) => m.role === "user")
      .slice(-3)
      .flatMap((m) => m.parts.map((p) => (p.type === "text" ? p.text : "")))
      .join(" ");
    const lastUserText =
      [...this.messages]
        .reverse()
        .find((m) => m.role === "user")
        ?.parts.map((p) => (p.type === "text" ? p.text : ""))
        .join(" ") ?? "";

    const savedProfile = this.getResumeProfile();

    const modelMessages = pruneMessages({
      messages: await convertToModelMessages(this.messages),
      toolCalls: "before-last-2-messages",
      reasoning: "before-last-message"
    });

    const result = streamText({
      model,
      system: `You are Job Search Copilot, an assistant that helps a candidate manage their job search.

You can:
- save a job posting/application as a note (saveJobNote), with company, role, status, and any notes
- list saved job notes (listJobNotes), optionally filtered by status
- update the status of a saved job (updateJobStatus) — e.g. "applied", "interviewing", "offer", "rejected"
- save or update the user's resume/profile summary (saveResumeProfile) so you can refer back to it later
- compare a pasted job description against the saved resume profile (compareJobToProfile) and point out
  matching skills and clear gaps — be honest and specific, don't inflate the match
- run a detailed background analysis of a pasted job posting that saves the job with a match score
  (analyzeJobPosting) — use this when the user asks to analyze, score, or track a job posting they pasted
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

        // Save tools return a plain-English confirmation rather than a JSON
        // flag like { saved: true }: with JSON results Llama 3.3 often
        // doesn't treat the action as done and calls the tool again.
        saveJobNote: tool({
          description:
            "Save a job posting or application as a note, so it can be recalled later.",
          inputSchema: z.object({
            company: z.string().describe("Company name"),
            role: z.string().describe("Job title / role"),
            status: z
              .enum(JOB_STATUSES)
              .optional()
              .describe('Defaults to "saved"'),
            notes: z
              .string()
              .optional()
              .describe("Any extra notes, e.g. JD summary or link")
          }),
          execute: async (input) => {
            const { id, updated } = this.saveJob(input);
            const status = input.status ?? "saved";
            return updated
              ? `Updated the existing note for ${input.company} – ${input.role} (status: ${status}, id: ${id}).`
              : `Saved ${input.company} – ${input.role} (status: ${status}, id: ${id}).`;
          }
        }),

        listJobNotes: tool({
          description: "List saved job notes, optionally filtered by status.",
          inputSchema: z.object({ status: z.enum(JOB_STATUSES).optional() }),
          execute: async ({ status }) => {
            const rows = this.listJobs(status);
            return rows.length ? rows : "No saved job notes yet.";
          }
        }),

        updateJobStatus: tool({
          description: "Update the status of a previously saved job note.",
          inputSchema: z.object({
            id: z.string().describe("The job note ID"),
            status: z.enum(JOB_STATUSES)
          }),
          execute: async ({ id, status }) => {
            const job = this.setJobStatus(id, status);
            return job
              ? `Updated ${job.company} – ${job.role} to "${status}".`
              : `No saved job with id ${id}. Use listJobNotes to find the right id.`;
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
            // must come from what the user wrote in their last few messages.
            if (wordOverlap(summary, recentUserText) < 0.5) {
              return "Not saved: this doesn't look like the user's own resume text. Ask the user to paste their resume or a summary of their experience.";
            }
            if (summary.trim() === savedProfile?.trim()) {
              return "Already saved: this is the user's current resume profile, so nothing changed.";
            }
            this.saveResumeProfile(summary);
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
            const profile = this.getResumeProfile();
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

        analyzeJobPosting: tool({
          description:
            "Save a pasted job posting and start a detailed background analysis that extracts its requirements and scores it against the saved resume. The result appears in the chat when ready.",
          inputSchema: z.object({
            company: z.string().describe("Company name"),
            role: z.string().describe("Job title / role"),
            jobDescription: z
              .string()
              .describe("The full job description text, as pasted")
          }),
          execute: async ({ company, role, jobDescription: modelText }) => {
            const jobDescription = groundedJobText(modelText, lastUserText);
            if (!jobDescription) {
              return "Not analyzed: this doesn't look like a job posting the user pasted. Ask the user to paste the full job posting text.";
            }
            if (!this.getResumeProfile()) {
              return "No resume saved yet, so there is nothing to score against. Ask the user to paste their resume first.";
            }
            if (jobDescription.trim().length < 150) {
              return "The job description is too short to analyze. Ask the user to paste the full job posting text.";
            }
            const { id: jobId } = this.saveJob({ company, role });
            await this.runWorkflow<JobAnalysisParams>(
              "JOB_ANALYSIS_WORKFLOW",
              { jobId, company, role, jobDescription },
              { metadata: { jobId } }
            );
            return `Saved ${company} – ${role} and started a background analysis. The match score will appear here in a few seconds.`;
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

    return result.toUIMessageStreamResponse({
      onError: (error) => {
        console.error("Chat stream error:", error);
        return friendlyAIError(error);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Background work: scheduled reminders and JobAnalysisWorkflow callbacks.
  // Results are pushed to connected browsers over the agent's WebSocket.
  // ---------------------------------------------------------------------------

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

  async onWorkflowProgress(
    _workflowName: string,
    workflowId: string,
    progress: unknown
  ) {
    this.broadcast(
      JSON.stringify({ type: "job-analysis-progress", workflowId, progress })
    );
  }

  async onWorkflowComplete(
    _workflowName: string,
    workflowId: string,
    result?: unknown
  ) {
    const analysis = result as JobAnalysisResult;
    this.broadcast(
      JSON.stringify({ type: "job-analysis-complete", workflowId, ...analysis })
    );
  }

  async onWorkflowError(
    _workflowName: string,
    workflowId: string,
    error: string
  ) {
    console.error(`Job analysis ${workflowId} failed:`, error);
    this.broadcast(
      JSON.stringify({
        type: "job-analysis-error",
        workflowId,
        // Our own errors (e.g. "No resume saved…") are already user-facing.
        error: error.startsWith("No resume saved")
          ? error
          : friendlyAIError(error)
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
