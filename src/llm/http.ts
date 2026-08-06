/**
 * HTTP client for any OpenAI-compatible chat-completions endpoint.
 *
 * Implemented with `fetch` rather than a vendor SDK, deliberately. The surface we need is
 * a single POST to `/chat/completions` — a stable, widely-implemented contract — and
 * depending on a vendor SDK would import that vendor's assumptions about endpoints,
 * error shapes, and parameters, which is precisely what breaks when you point the same
 * code at Groq or a local server. Sixty lines of fetch is the portable choice here.
 *
 * Configure with environment variables:
 *
 *   OpenAI    LLM_BASE_URL=https://api.openai.com/v1      LLM_MODEL=gpt-4o-mini
 *   Groq      LLM_BASE_URL=https://api.groq.com/openai/v1 LLM_MODEL=llama-3.3-70b-versatile
 *   Together  LLM_BASE_URL=https://api.together.xyz/v1    LLM_MODEL=…
 *   Ollama    LLM_BASE_URL=http://localhost:11434/v1      LLM_MODEL=…   (any key)
 */

import { LlmError, type LlmClient, type LlmRequest, type LlmResponse } from "./types.js";

export interface HttpLlmOptions {
  apiKey: string;
  baseUrl?: string;
  model: string;
  /** Retries on 429 and 5xx, with exponential backoff. */
  maxRetries?: number;
  timeoutMs?: number;
  /** Extra headers some gateways require (e.g. OpenRouter attribution). */
  headers?: Record<string, string>;
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  model?: string;
  error?: { message?: string };
}

export class HttpLlmClient implements LlmClient {
  private readonly baseUrl: string;
  readonly label: string;

  constructor(private readonly opts: HttpLlmOptions) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.label = `${hostOf(this.baseUrl)}/${opts.model}`;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const maxRetries = this.opts.maxRetries ?? 3;
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) await sleep(Math.min(500 * 2 ** (attempt - 1), 8000));
      try {
        return await this.once(req);
      } catch (err) {
        lastError = err;
        const retriable =
          err instanceof LlmError &&
          (err.status === 429 || (err.status !== undefined && err.status >= 500));
        if (!retriable) throw err;
      }
    }
    throw lastError;
  }

  private async once(req: LlmRequest): Promise<LlmResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 120_000);

    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.opts.apiKey}`,
          ...this.opts.headers,
        },
        body: JSON.stringify({
          model: this.opts.model,
          temperature: req.temperature ?? 0,
          ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
          // Widely supported; providers that ignore it still work, because output is
          // parsed and validated on our side regardless.
          ...(req.json ? { response_format: { type: "json_object" } } : {}),
          messages: [
            { role: "system", content: req.system },
            { role: "user", content: req.user },
          ],
        }),
      });

      const raw = await res.text();
      if (!res.ok) {
        throw new LlmError(
          `${this.label} returned ${res.status} ${res.statusText}`,
          res.status,
          raw.slice(0, 500),
        );
      }

      let body: ChatCompletionResponse;
      try {
        body = JSON.parse(raw) as ChatCompletionResponse;
      } catch {
        throw new LlmError(`${this.label} returned non-JSON body`, res.status, raw.slice(0, 500));
      }

      const text = body.choices?.[0]?.message?.content;
      if (typeof text !== "string") {
        throw new LlmError(
          `${this.label} returned no message content${body.error?.message ? `: ${body.error.message}` : ""}`,
          res.status,
          raw.slice(0, 500),
        );
      }

      return {
        text,
        model: body.model,
        usage: {
          promptTokens: body.usage?.prompt_tokens,
          completionTokens: body.usage?.completion_tokens,
        },
      };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new LlmError(`${this.label} timed out`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^api\./, "");
  } catch {
    return url;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
