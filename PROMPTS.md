# Development & Prompt History

This project was built iteratively using Claude Sonnet and Claude Code. Below is the step-by-step log of how we designed, tested, debugged, and deployed the app, written directly from our working sessions.

---

## Phase 1: Planning & Initial Setup

### Project Goal
Build an AI Job Search Copilot on Cloudflare using:
- **LLM:** Llama 3.3 70B on Workers AI
- **State & Memory:** Durable Objects with built-in SQLite
- **Workflows:** Cloudflare Workflows for background processing
- **Frontend:** React chat UI running on Workers / Pages

---

### Step 1: Clarifying the Stack & Scaffolding

> **User:** "I'm working on a Cloudflare assignment to build an AI application using Llama 3.3 on Workers AI, Durable Objects for state, and a chat interface. 
> 
> I want to build a **Job Search Copilot**—an assistant that can save resume details, organize job notes, compare job descriptions to my profile, and schedule reminders.
> 
> Walk me through setting up the starter using `npx create-cloudflare@latest --template cloudflare/agents-starter` and setting up my initial bindings in `wrangler.jsonc`."

---

### Step 2: Building Core Agent Tools & SQLite Persistence

> **User:** "Let's build out the agent code in `src/server.ts` and UI in `src/app.tsx`. 
> 
> Here's what we need:
> 1. Rename `ChatAgent` to `JobSearchCopilot`. In `onStart()`, create two SQLite tables: `job_notes` and `resume_profile`.
> 2. Add custom tools: `saveJobNote`, `listJobNotes`, `updateJobStatus`, `saveResumeProfile`, and `compareJobToProfile`. Keep the existing task scheduling tools for reminders.
> 3. Inject the saved resume profile into the system prompt so the model always knows my background when answering questions.
> 4. Run `wrangler types`, `tsc --noEmit`, `oxlint src/`, and `vite build` to make sure there are no type or lint errors."

---

## Phase 2: Local Testing, Bug Fixes & Live Deployment

### Step 3: Git Setup & First Deployment Attempt

> **User:** "Let's push this to GitHub and deploy it to Cloudflare:
> 
> 1. Initialize Git and push everything to `https://github.com/aravinthM172/Ai-Agent` on `main`.
> 2. Run `npm install` and verify the build passes.
> 3. Log into Cloudflare with `wrangler login` and register my `workers.dev` subdomain (`aravinthm172`).
> 4. Run `npm run dev` locally and test `saveResumeProfile`, `compareJobToProfile`, and `saveJobNote` in the browser chat.
> 5. Once local testing works, run `npm run deploy` and send me the live URL."

---

### Step 4: Debugging Corrupted AI Stream Outputs

> **User:** "When I test locally with `npm run dev`, tool calls are failing and getting stuck in a loop.
> 
> Looking at the logs, the tool arguments are coming back duplicated and corrupted—like `{"summary": "{"summary": "BackendBackend...}`.
> 
> It looks like Workers AI's Llama 3.3 stream is sending chunk updates in both `choices[0].delta` and the older top-level `response`/`tool_calls` fields at the same time, causing `workers-ai-provider` to parse the same data twice.
> 
> Let's fix this in `src/server.ts` by adding a wrapper function (`dedupeStreamChunks`) around the `AI` binding to clean up those duplicate legacy fields before passing them to the provider."

---

### Step 5: Fixing Repeated Tool Loops

> **User:** "The agent is still getting stuck repeating the same tool over and over if I send a message without enough details or missing text.
> 
> Let's add a few guardrails:
> 1. Have tools return simple text responses (like 'Resume saved successfully') instead of raw JSON objects so the model doesn't re-query.
> 2. Add validation inside `saveResumeProfile` and `compareJobToProfile` so they refuse to run if key text is missing.
> 3. Cap tool calls at 3 rounds max. If the model hits 3 rounds, strip out the available tools and force a final plain-text answer.
> 4. Make sure `maxOutputTokens` is set to 1024 so answers don't get cut off mid-sentence."

---

### Step 6: Handling API Quota Errors

> **User:** "The live site is throwing 'An error occurred' when I try to message it.
> 
> When I check the network tab, Workers AI is returning error code 4006—we ran out of the free daily 10,000 neuron limit during testing.
> 
> Let's handle this properly in the frontend: intercept raw API error codes like 4006 and show a clear, friendly error banner at the top of the chat explaining that the daily limit was reached."

---

## Phase 3: Scaling & Platform Upgrades

### Step 7: Architecture Upgrades for Production

> **User:** "Let's upgrade this from a simple demo into a solid, multi-user system:
> 
> 1. **Per-User Isolation:** Stop sharing a single `default` Durable Object across all users. Have the frontend generate a unique session ID in `localStorage` so every visitor gets their own isolated Durable Object and SQLite database.
> 2. **Cloudflare Workflow:** Create a background `JobAnalysisWorkflow` for detailed job evaluation. When a user pastes a job description, offload the requirement extraction and matching to this workflow, then send progress updates back to the UI in real time.
> 3. **Smart Matching Engine:** Build a dedicated matching module in `src/lib/matching.ts` that handles skill aliases, checks for negative requirements (like 'No Kubernetes required'), and calculates an experience-gap score.
> 4. **AI Gateway & Tests:** Route model calls through Cloudflare AI Gateway to enable caching, and set up a Vitest suite using `@cloudflare/vitest-pool-workers` to test our matching logic, workflow execution, and per-user state isolation."

---

## Summary of Results

By following this iterative approach, we:
- Built a multi-tenant AI agent with isolated SQLite storage per session.
- Fixed stream parser bugs and model looping edge-cases.
- Added background workflows and deterministic matching logic.
- Built a reliable test suite that passes cleanly in CI/CD.
