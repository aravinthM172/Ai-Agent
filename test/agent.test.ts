import { env, introspectWorkflowInstance } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { JobRequirements } from "../src/lib/matching";

// Each test uses its own agent name, i.e. its own Durable Object and SQLite
// database, the same way each browser session does in production.
const agent = (name: string) => getAgentByName(env.JobSearchCopilot, name);

describe("JobSearchCopilot storage (Durable Object SQLite)", () => {
  it("saves and lists jobs", async () => {
    const copilot = await agent("storage-basic");
    const { id, updated } = await copilot.saveJob({
      company: "Acme Corp",
      role: "Backend Engineer",
      status: "applied"
    });
    expect(updated).toBe(false);

    const jobs = await copilot.listJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      id,
      company: "Acme Corp",
      role: "Backend Engineer",
      status: "applied",
      match_score: null
    });
    expect(await copilot.listJobs("offer")).toHaveLength(0);
  });

  it("updates instead of duplicating the same company + role", async () => {
    const copilot = await agent("storage-dedupe");
    const first = await copilot.saveJob({ company: "Acme", role: "SDE" });
    // Llama sometimes repeats a save; different casing, new status and notes.
    const second = await copilot.saveJob({
      company: "ACME",
      role: "sde",
      status: "interviewing",
      notes: "referral from Priya"
    });

    expect(second).toEqual({ id: first.id, updated: true });
    const jobs = await copilot.listJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      status: "interviewing",
      notes: "referral from Priya"
    });
  });

  it("keeps existing notes when a repeat save has none", async () => {
    const copilot = await agent("storage-notes");
    await copilot.saveJob({ company: "A", role: "B", notes: "keep me" });
    await copilot.saveJob({ company: "A", role: "B", status: "applied" });
    expect((await copilot.listJobs())[0].notes).toBe("keep me");
  });

  it("updates status and reports unknown ids", async () => {
    const copilot = await agent("storage-status");
    const { id } = await copilot.saveJob({ company: "Globex", role: "SRE" });
    expect(await copilot.setJobStatus(id, "offer")).toMatchObject({
      company: "Globex",
      status: "offer"
    });
    expect(await copilot.setJobStatus("no-such-id", "offer")).toBeNull();
  });

  it("stores one resume profile, replacing the old one", async () => {
    const copilot = await agent("storage-profile");
    expect(await copilot.getResumeProfile()).toBeNull();
    await copilot.saveResumeProfile("v1");
    await copilot.saveResumeProfile("v2");
    expect(await copilot.getResumeProfile()).toBe("v2");
  });

  it("isolates data between users (one Durable Object each)", async () => {
    const alice = await agent("isolation-alice");
    const bob = await agent("isolation-bob");
    await alice.saveJob({ company: "Alice Co", role: "Engineer" });
    await alice.saveResumeProfile("Alice's resume");

    expect(await bob.listJobs()).toEqual([]);
    expect(await bob.getResumeProfile()).toBeNull();
  });
});

describe("JobAnalysisWorkflow", () => {
  const PROFILE =
    "Backend engineer with 4 years of experience. Skills: TypeScript, Node.js, PostgreSQL, Docker, AWS. No Kubernetes experience.";
  // What the LLM step would return; mocked so tests never call Workers AI.
  const REQUIREMENTS: JobRequirements = {
    requiredSkills: ["TypeScript", "PostgreSQL", "Kubernetes", "AWS"],
    niceToHaveSkills: ["Docker"],
    minYearsExperience: 5,
    seniority: "senior",
    summary: "Senior backend engineer."
  };

  it("extracts, scores, and saves the analysis back to the agent", async () => {
    const copilot = await agent("workflow-user");
    await copilot.saveResumeProfile(PROFILE);
    const { id: jobId } = await copilot.saveJob({
      company: "Acme",
      role: "Senior Backend Engineer"
    });

    const workflowId = "analysis-test-1";
    await using instance = await introspectWorkflowInstance(
      env.JOB_ANALYSIS_WORKFLOW,
      workflowId
    );
    await instance.modify(async (m) => {
      await m.mockStepResult({ name: "extract-requirements" }, REQUIREMENTS);
    });

    await copilot.runWorkflow(
      "JOB_ANALYSIS_WORKFLOW",
      {
        jobId,
        company: "Acme",
        role: "Senior Backend Engineer",
        jobDescription: "(mocked)"
      },
      { id: workflowId }
    );

    await instance.waitForStatus("complete");
    expect(await instance.getOutput()).toEqual({
      jobId,
      company: "Acme",
      role: "Senior Backend Engineer",
      // 3/4 required skills = 75, minus 10 for being one year short
      score: 65,
      matchedSkills: ["TypeScript", "PostgreSQL", "AWS"],
      missingSkills: ["Kubernetes"]
    });

    // The score was written to the agent's SQLite via RPC.
    const [job] = await copilot.listJobs();
    expect(job.match_score).toBe(65);
  });
});
