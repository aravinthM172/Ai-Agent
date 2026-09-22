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

---

## Deployment via Claude Code (2026-09-22)

The project was then pushed, tested, and deployed from a separate Claude Code
session (Claude Opus 5.5), from the project folder unzipped from
`job-search-copilot.zip`.

**User (condensed):** Initialize git and push to
`github.com/aravinthM172/Ai-Agent` on `main`; run `npm install`; log into
Cloudflare and confirm `npm run dev` works by testing `saveResumeProfile`,
`compareJobToProfile`, and `saveJobNote`; deploy with `npm run deploy`;
check README/PROMPT_HISTORY accuracy and note this step here.

**Claude Code:**
1. Initialized git and pushed to `main` (the GitHub repo was still empty at
   this point, so this was the first push of the code). `npm install`, `tsc`,
   and `oxlint` all passed.
2. Logged into Cloudflare with `wrangler login`. `npm run dev` initially
   failed with error 10063 because the account had no `workers.dev`
   subdomain, so one (`aravinthm172`) was registered through the Cloudflare API.
3. Testing in the chat UI showed **every tool call failing** and the model
   retrying in a loop. Root cause: Workers AI's Llama 3.3 stream now sends
   each delta both in `choices[0].delta` and in legacy top-level
   `response`/`tool_calls` fields, and `workers-ai-provider` 3.x consumes
   both, producing corrupted arguments like
   `{"summary": "{"summary": "BackendBackend ...`. Reproduced it outside the
   Durable Object with `getPlatformProxy` (3.2.1 and 3.3.1 both affected;
   4.0.0 requires `ai` v7). Fixed by wrapping the `AI` binding
   (`dedupeStreamChunks` in `src/server.ts`) to strip the duplicate legacy
   fields.
4. Replaced the starter's leftover suggested prompts (weather, calculator)
   with job-search prompts that match the real tools.
5. Re-tested locally: `saveResumeProfile`, `compareJobToProfile`,
   `saveJobNote`, and `listJobNotes` all worked end to end against
   SQLite in the Durable Object.
6. Deployed with `npm run deploy` to
   https://job-search-copilot.aravinthm172.workers.dev, and updated
   `README.md` (live URL, subdomain requirement, the streaming workaround)
   and `.dev.vars.example` (wrangler reads the token from `.env`, not
   `.dev.vars`).

**User (follow-up):**
> i typed once it sending sam msg again again

**Claude Code:** Read the live chat history and found the agent looping. The user had sent a message without a real job posting or resume. Llama then alternated between `compareJobToProfile` and `saveResumeProfile` until the 20-step limit, and saved an invented placeholder as the resume. Testing the model outside the Durable Object showed:
- Llama repeats a tool much less often when the tool returns a plain-English confirmation instead of JSON like `{ saved: true }`.
- Removing tools (`activeTools`) or forcing `toolChoice: "none"` doesn't stop Llama. With tool calls still in the history, it either keeps calling the tools or prints the calls as JSON.
- `workers-ai-provider` sends `tools: []` for tool-less steps, which Workers AI rejects.
- The provider defaults to `max_tokens: 256`.

Fixes, deployed and re-tested live with the same message:
- Save tools return plain-text results.
- `saveJobNote` upserts instead of duplicating.
- The resume and job-description tools refuse input that is missing or invented.
- After a repeated call or 3 tool rounds, a final step with no tools and no tool-call history makes the model answer in plain text.
- The binding wrapper omits empty `tools` arrays, and `maxOutputTokens` is set to 1024.
