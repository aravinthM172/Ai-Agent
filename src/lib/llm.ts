/**
 * Chooses the LLM provider. Groq (gpt-oss-120b, free tier) is used when a
 * GROQ_API_KEY secret is set; otherwise Llama 3.3 on Workers AI, so local dev
 * and tests work without a key.
 */
import { createGroq } from "@ai-sdk/groq";
import type { LanguageModel } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { CHAT_MODEL, fixWorkersAIBinding } from "./workers-ai";

// Groq has retired Llama 3.3 70B; gpt-oss-120b is its strongest open model
// for tool calling and JSON mode.
export const GROQ_MODEL = "openai/gpt-oss-120b";

export function usesGroq(env: Env): boolean {
  return Boolean(env.GROQ_API_KEY);
}

/**
 * Groq is called directly, not through AI Gateway: this account's gateway
 * requires Cloudflare authentication (error 2009), which the gateway's
 * provider URL doesn't carry. Workers AI calls still go through the gateway.
 */
export const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

/** The chat model for the agent's streamText call. */
export function chatModel(env: Env, sessionAffinity: string): LanguageModel {
  if (usesGroq(env)) {
    const groq = createGroq({
      apiKey: env.GROQ_API_KEY,
      baseURL: GROQ_BASE_URL
    });
    return groq(GROQ_MODEL);
  }
  const workersai = createWorkersAI({
    binding: fixWorkersAIBinding(env.AI),
    // Every model call goes through AI Gateway for logging, analytics, and
    // rate limiting in one place (Cloudflare dashboard → AI → AI Gateway).
    gateway: { id: env.AI_GATEWAY_ID }
  });
  return workersai(CHAT_MODEL, { sessionAffinity });
}
