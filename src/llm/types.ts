/**
 * Model provider abstraction.
 *
 * Deliberately narrow: one chat-completion call returning text. That is the entire
 * surface the pipeline needs, and keeping it this small is what makes the pipeline
 * portable across any provider exposing an OpenAI-compatible `/chat/completions`
 * endpoint — OpenAI, Groq, Together, Fireworks, OpenRouter, or a local vLLM/Ollama
 * server.
 *
 * Note what is NOT delegated to the provider: output validation. Structured-output
 * support varies (OpenAI has strict `json_schema`; several compatible providers only
 * support `json_object`, and some neither). Since the architecture validates every model
 * output against a closed label set and gates every claim on citation verification
 * regardless, provider-side schema enforcement is a convenience, never a dependency.
 * That is what makes provider-agnosticism cheap here rather than a compromise.
 */

export interface LlmRequest {
  system: string;
  user: string;
  /** Ask for JSON. Providers that ignore it still work — we parse and validate anyway. */
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
}

export interface LlmResponse {
  text: string;
  /** Provider-reported usage when available; absent on providers that omit it. */
  usage?: { promptTokens?: number; completionTokens?: number };
  model?: string;
}

export interface LlmClient {
  complete(req: LlmRequest): Promise<LlmResponse>;
  /** Identifies the provider/model in reports and cassette keys. */
  readonly label: string;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "LlmError";
  }
}
