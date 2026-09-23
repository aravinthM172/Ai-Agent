/**
 * JobAnalysisWorkflow — a durable, multi-step analysis of one job posting.
 *
 * Why a Workflow instead of doing this inside the chat turn:
 *  - The LLM call can fail transiently (rate limits, timeouts, the model
 *    returning malformed JSON). Each step here is retried with backoff, and
 *    completed steps are never re-run, so a failure in step 3 doesn't repeat
 *    the (paid) LLM call from step 1.
 *  - It runs in the background: the chat answers immediately and the result
 *    is pushed to the browser when it's ready (progress → complete events).
 *  - Its state survives Worker restarts and deploys mid-run.
 *
 * Steps:
 *  1. extract-requirements: Llama 3.3 in JSON mode → validated requirements
 *  2. load-profile:         read the resume from the Agent's SQLite (RPC)
 *  3. save-analysis:        deterministic score (matching.ts) → Agent SQLite
 */
import { AgentWorkflow } from "agents/workflows";
import type { AgentWorkflowEvent, AgentWorkflowStep } from "agents/workflows";
import { scoreMatch } from "../lib/matching";
import { extractRequirements } from "../lib/requirements";
import type { JobSearchCopilot } from "../server";

export type JobAnalysisParams = {
  jobId: string;
  company: string;
  role: string;
  jobDescription: string;
};

export type JobAnalysisResult = {
  jobId: string;
  company: string;
  role: string;
  score: number;
  matchedSkills: string[];
  missingSkills: string[];
};

export class JobAnalysisWorkflow extends AgentWorkflow<
  JobSearchCopilot,
  JobAnalysisParams
> {
  async run(
    event: AgentWorkflowEvent<JobAnalysisParams>,
    step: AgentWorkflowStep
  ): Promise<JobAnalysisResult> {
    const { jobId, company, role, jobDescription } = event.payload;

    await this.reportProgress({
      step: "extract-requirements",
      status: "running",
      percent: 0.1
    });
    const requirements = await step.do(
      "extract-requirements",
      {
        retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
        timeout: "2 minutes"
      },
      () => extractRequirements(this.env, jobDescription)
    );

    await this.reportProgress({
      step: "score-match",
      status: "running",
      percent: 0.6
    });
    const profile = await step.do("load-profile", () =>
      this.agent.getResumeProfile()
    );
    if (!profile) {
      throw new Error(
        "No resume saved. Save your resume first, then run the analysis again."
      );
    }
    const match = scoreMatch(requirements, profile);

    await step.do("save-analysis", () =>
      this.agent.saveJobAnalysis(jobId, { requirements, match })
    );

    const result: JobAnalysisResult = {
      jobId,
      company,
      role,
      score: match.score,
      matchedSkills: match.matchedSkills,
      missingSkills: match.missingSkills
    };
    await step.reportComplete(result);
    return result;
  }
}
