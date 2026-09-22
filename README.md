# Job Search Copilot

**Live demo:** https://job-search-copilot.aravinthm172.workers.dev

An AI agent, built on Cloudflare, that helps track job applications and check a job description against your resume/profile.

Built for the Cloudflare Agents assignment (see [agents.cloudflare.com](https://agents.cloudflare.com/) and the [Agents SDK docs](https://developers.cloudflare.com/agents/)). It uses the four required components:

| Component | What it uses |
|---|---|
| LLM | **Llama 3.3** on Workers AI (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`) |
| Workflow / coordination | A **Durable Object** (`JobSearchCopilot`, via the Agents SDK) running the tool-call loop, plus the SDK's built-in task scheduler for follow-up reminders |
| User input | **Chat**, served from a React/Vite frontend on Cloudflare Workers assets (Pages-style static hosting) |
| Memory / state | **SQLite storage inside the Durable Object** — saved job notes and the resume/profile summary persist across sessions and page reloads |

## What it does

- **Save a job application as a note** — company, role, status, and any notes ("save this: Acme Corp, Backend Engineer, applied today")
- **List saved jobs**, optionally filtered by status (saved / applied / interviewing / offer / rejected)
- **Update a job's status** as you move through the process
- **Save your resume/profile summary** once, so the agent can refer back to it
- **Compare a pasted job description against your saved profile** — matching skills, gaps, and one honest recommendation (no inflated claims)
- **Schedule follow-up reminders** ("remind me to follow up with Acme in 3 days")

All of this is backed by real tool calls the model makes during the conversation (see `src/server.ts`), not just prompting — the model decides when to call `saveJobNote`, `compareJobToProfile`, etc., and the Durable Object executes them against its own SQLite storage.

## Project structure

```
src/
  server.ts   # Durable Object agent: Workers AI model, tools, SQLite tables
  app.tsx     # React chat UI
  client.tsx  # Vite entry point
  styles.css
public/       # static assets served by Workers assets (Pages-style)
wrangler.jsonc
```

## Running it

```bash
npm install
npm run dev
```

**Cloudflare authentication is required to run locally.** This project uses Workers AI with `"ai": { "remote": true }` in `wrangler.jsonc`, and Workers AI has no local simulator — so `npm run dev` opens a remote proxy session against Cloudflare and needs you to be logged in. Either run `wrangler login` once in an interactive terminal, or set a `CLOUDFLARE_API_TOKEN` environment variable in your shell or a `.env` file (see `.dev.vars.example` for the variable name). Your account also needs a `workers.dev` subdomain registered (Workers & Pages → onboarding in the dashboard); remote dev mode fails with error 10063 without one. No third-party (OpenAI/Anthropic) API key is needed — Workers AI is billed to your Cloudflare account and has a free tier.

Open [http://localhost:5173](http://localhost:5173).

Try:
- **"Save my resume: <paste a short summary>"** → saves the profile via `saveResumeProfile`
- **Paste a job description and ask "how do I match up?"** → `compareJobToProfile`
- **"Save this job: Acme Corp, Backend Engineer, I just applied"** → `saveJobNote`
- **"What jobs have I applied to?"** → `listJobNotes`
- **"Remind me to follow up on the Acme application in 3 days"** → scheduling

## Deploying

```bash
npm run deploy
```

This runs `vite build && wrangler deploy`, which needs a Cloudflare account with Workers enabled (`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, or an interactive `wrangler login`).

## Workarounds for Llama 3.3 / Workers AI quirks

`src/server.ts` contains a few deliberate workarounds, found while testing the deployed agent:

- **Duplicated stream deltas.** Workers AI streams for Llama 3.3 now include each delta twice per SSE chunk (in `choices[0].delta` and in the legacy top-level `response` / `tool_calls` fields). `workers-ai-provider` 3.x reads both, corrupting tool-call arguments so every tool call fails. `fixWorkersAIBinding` strips the legacy fields. It also drops the empty `tools: []` array the provider sends for tool-less steps, which Workers AI rejects. Both can go once the project moves to a provider version that handles this (4.x requires `ai` v7).
- **Repeated tool calls.** Llama 3.3 tends to call tools again and again, and even invented placeholder data (e.g. saved "Please share your resume…" as the resume). Mitigations:
  - Save tools return plain-English confirmations instead of JSON flags.
  - `saveJobNote` updates an existing company + role instead of duplicating it.
  - `saveResumeProfile` refuses text that isn't grounded in the user's message.
  - `compareJobToProfile` refuses a missing or too-short job description.
  - After a repeated call or 3 tool rounds, a final tool-free step makes the model answer in plain text.
- **Output length.** The provider defaults to 256 output tokens, which truncated comparisons; `maxOutputTokens` is set to 1024.

## AI-assisted development

This project was scaffolded from Cloudflare's official `cloudflare/agents-starter` template and then customized (system prompt, tools, SQLite schema, branding) with AI assistance (Claude). See [`PROMPT_HISTORY.md`](./PROMPT_HISTORY.md) for the prompt history, as requested in the assignment.
