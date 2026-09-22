# Prompt history

This project was built inside a Claude session (Claude Sonnet). Below is the
prompt history relevant to this build, in order, condensed for readability
(the earlier part of the session was unrelated resume-editing work and is
omitted).

---

**User:**
> We plan to fast track candidates who complete an assignment to build a
> type of AI-powered application (https://agents.cloudflare.com/) on
> Cloudflare. An AI-powered application should include the following
> components: LLM (recommend using Llama 3.3 on Workers AI, or an external
> LLM), Workflow/coordination (Workflows, Workers or Durable Objects), User
> input via chat or voice (Pages or Realtime), Memory or state. Additional
> docs: https://developers.cloudflare.com/agents/. Note: AI-assisted coding
> is encouraged, but you have to submit prompt history.

**Claude:** Asked clarifying questions — what kind of app to build, which
LLM/stack to use, and whether a Cloudflare account/wrangler was already set
up.

**User:** Answered with a link to the docs instead of picking a preset app
idea, said "best option" for the stack question, and "not sure / walk me
through it" for Cloudflare setup.

**Claude:** Fetched both pages (`agents.cloudflare.com` and
`developers.cloudflare.com/agents/`) to confirm the required components and
the recommended getting-started path (`npx create-cloudflare@latest
--template cloudflare/agents-starter`). Proposed a concrete app — a
**Job Search Copilot** chat agent (tying into the user's active job search)
— using Llama 3.3 on Workers AI, a Durable Object for coordination and
memory, and a Pages-style chat UI. Gave step-by-step instructions for
creating a Cloudflare account, enabling Workers, and generating an API
token + Account ID.

**User:**
> Optional Assignment: Please share GitHub repo URL for the project here
> [repeated the same assignment brief]

**Claude:** Proceeded to build the project:
1. Cloned `cloudflare/agents-starter` (the official Cloudflare template).
2. Renamed the agent class from `ChatAgent` to `JobSearchCopilot` and
   updated `wrangler.jsonc`, `package.json`, and the client's `useAgent`
   call to match (binding name → kebab-case route name).
3. Rewrote `src/server.ts`:
   - Switched the model to `@cf/meta/llama-3.3-70b-instruct-fp8-fast` on
     Workers AI (per the assignment's recommendation).
   - Added a SQLite schema (`job_notes`, `resume_profile`) created in
     `onStart()`, using the Agent base class's built-in `this.sql` — this is
     the "memory or state" component, persisted inside the Durable Object
     and surviving reloads/redeploys.
   - Replaced the starter's generic demo tools (weather/calculator) with
     job-search-specific tools: `saveJobNote`, `listJobNotes`,
     `updateJobStatus`, `saveResumeProfile`, `compareJobToProfile`, plus kept
     `scheduleTask` / `getScheduledTasks` / `cancelScheduledTask` for
     follow-up reminders.
   - Updated the system prompt to describe the assistant's role and
     available tools, and to inject the saved resume profile into context
     when present.
4. Rebranded the UI (`index.html` title, header text in `src/app.tsx`).
5. Verified the build: `wrangler types`, `tsc --noEmit`, `oxlint src/`, and
   `vite build` all pass cleanly.
6. Wrote `README.md` describing the four required components, how to run
   and deploy the project, and example prompts to try.
7. Wrote this prompt history file and pushed the project to a new GitHub
   repository, whose URL was shared back in the conversation.

No other AI tool was used for this build — all code was written by Claude
inside the session, reviewed and adjusted by re-running the type checker,
linter, and build after each change described above.
