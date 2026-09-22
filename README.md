# Job Search Copilot

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

**Cloudflare authentication is required to run locally.** This project uses Workers AI with `"ai": { "remote": true }` in `wrangler.jsonc`, and Workers AI has no local simulator — so `npm run dev` opens a remote proxy session against Cloudflare and needs you to be logged in. Either run `wrangler login` once in an interactive terminal, or set a `CLOUDFLARE_API_TOKEN` environment variable (e.g. in a `.env` file, see `.dev.vars.example`). No third-party (OpenAI/Anthropic) API key is needed — Workers AI is billed to your Cloudflare account and has a free tier.

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

This runs `wrangler deploy`, which needs a Cloudflare account with Workers enabled (`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, or an interactive `wrangler login`).

## AI-assisted development

This project was scaffolded from Cloudflare's official `cloudflare/agents-starter` template and then customized (system prompt, tools, SQLite schema, branding) with AI assistance (Claude). See [`PROMPT_HISTORY.md`](./PROMPT_HISTORY.md) for the prompt history, as requested in the assignment.
