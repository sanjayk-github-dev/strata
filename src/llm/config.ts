/**
 * Provider configuration from the environment.
 *
 * Any OpenAI-compatible endpoint works. `OPENAI_*` names are accepted as fallbacks
 * because they are conventional, but `LLM_*` is preferred since the provider need not be
 * OpenAI.
 */

import { HttpLlmClient } from "./http.js";
import type { LlmClient } from "./types.js";

export interface ResolvedLlmConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export const PROVIDER_EXAMPLES = [
  ["OpenAI", "https://api.openai.com/v1", "gpt-4o-mini"],
  ["Groq", "https://api.groq.com/openai/v1", "llama-3.3-70b-versatile"],
  ["Together", "https://api.together.xyz/v1", "meta-llama/Llama-3.3-70B-Instruct-Turbo"],
  ["OpenRouter", "https://openrouter.ai/api/v1", "openai/gpt-4o-mini"],
  ["Ollama (local)", "http://localhost:11434/v1", "llama3.1"],
] as const;

export class MissingLlmConfigError extends Error {
  constructor() {
    super(
      "No model provider configured. Set LLM_API_KEY (or OPENAI_API_KEY), and optionally\n" +
        "LLM_BASE_URL and LLM_MODEL, in .env.local or the environment.\n\n" +
        PROVIDER_EXAMPLES.map(
          ([name, url, model]) =>
            `  ${name.padEnd(15)} LLM_BASE_URL=${url}\n  ${" ".repeat(15)} LLM_MODEL=${model}`,
        ).join("\n"),
    );
    this.name = "MissingLlmConfigError";
  }
}

const env = (...names: string[]): string | undefined => {
  for (const n of names) {
    const v = process.env[n];
    if (v && v.trim() !== "") return v.trim();
  }
  return undefined;
};

export function resolveLlmConfig(): ResolvedLlmConfig | null {
  const apiKey = env("LLM_API_KEY", "OPENAI_API_KEY");
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: env("LLM_BASE_URL", "OPENAI_BASE_URL") ?? "https://api.openai.com/v1",
    model: env("LLM_MODEL", "OPENAI_MODEL") ?? "gpt-4o-mini",
  };
}

/** Build a client from the environment, or throw with setup instructions. */
export function llmFromEnv(): LlmClient {
  const cfg = resolveLlmConfig();
  if (!cfg) throw new MissingLlmConfigError();
  return new HttpLlmClient(cfg);
}
