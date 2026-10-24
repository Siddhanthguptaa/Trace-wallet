/**
 * OpenAI-compatible LLM backends for real-agent experiments (Final_implementation.md).
 * Uses global fetch (Node 18+). Keys via OPENAI_API_KEY, SARVAM_API_KEY, LOCAL_LLM_BASE_URL.
 */

import { OPENAI_CHAT_MODEL } from "../../openaiModel";

export interface TaskRequest {
  taskType: "summarise" | "qa" | "classify";
  payload: string;
  maxTokens: number;
}

export interface AgentBackendConfig {
  providerId: string;
  model: string;
  baseUrl: string;
  apiKey: string | null;
  /** Sarvam docs: some accounts use api-subscription-key instead of Bearer. */
  authHeader?: "authorization" | "api-subscription-key";
}

export function defaultOpenAiFleet(): AgentBackendConfig[] {
  return [
    {
      providerId: "openai-mini-1",
      model: OPENAI_CHAT_MODEL,
      baseUrl: "https://api.openai.com/v1",
      apiKey: process.env.OPENAI_API_KEY ?? null,
    },
  ];
}

export function defaultSarvamFleet(): AgentBackendConfig[] {
  const key = process.env.SARVAM_API_KEY ?? null;
  return [
    {
      providerId: "sarvam-30b-a",
      model: "sarvam-30b",
      baseUrl: "https://api.sarvam.ai/v1",
      apiKey: key,
    },
    {
      providerId: "sarvam-105b-a",
      model: "sarvam-105b",
      baseUrl: "https://api.sarvam.ai/v1",
      apiKey: key,
    },
  ];
}

export function defaultLocalLlamaFleet(): AgentBackendConfig[] {
  return [
    {
      providerId: "local-llama-8b",
      model: process.env.LOCAL_LLM_MODEL ?? "llama3.1:8b",
      baseUrl: process.env.LOCAL_LLM_BASE_URL ?? "http://127.0.0.1:11434/v1",
      apiKey: null,
    },
  ];
}

/** Groq OpenAI-compatible API (free tier sufficient for thousands of eval calls). */
export function defaultGroqFleet(): AgentBackendConfig[] {
  const key = process.env.GROQ_API_KEY ?? null;
  const model = process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile";
  return [
    {
      providerId: "groq-default",
      model,
      baseUrl: "https://api.groq.com/openai/v1",
      apiKey: key,
    },
  ];
}

/** Together.ai OpenAI-compatible API. */
export function defaultTogetherFleet(): AgentBackendConfig[] {
  const key = process.env.TOGETHER_API_KEY ?? null;
  const model = process.env.TOGETHER_MODEL ?? "meta-llama/Llama-3.3-70B-Instruct-Turbo";
  return [
    {
      providerId: "together-default",
      model,
      baseUrl: "https://api.together.xyz/v1",
      apiKey: key,
    },
  ];
}

export class HonestLLMProvider {
  constructor(private readonly config: AgentBackendConfig) {}

  get id(): string {
    return this.config.providerId;
  }

  async executeTask(task: TaskRequest): Promise<{
    output: string;
    latencyMs: number;
    tokensUsed: number;
  }> {
    const start = Date.now();
    const url = `${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.config.apiKey) {
      if (this.config.authHeader === "api-subscription-key") {
        headers["api-subscription-key"] = this.config.apiKey;
      } else {
        headers.Authorization = `Bearer ${this.config.apiKey}`;
      }
    }
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.config.model,
        messages: [{ role: "user", content: task.payload }],
        max_tokens: task.maxTokens,
      }),
    });
    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { total_tokens?: number };
      error?: { message?: string };
    };
    if (!resp.ok) {
      throw new Error(data.error?.message ?? `LLM HTTP ${resp.status}`);
    }
    return {
      output: data.choices?.[0]?.message?.content ?? "",
      latencyMs: Date.now() - start,
      tokensUsed: data.usage?.total_tokens ?? 0,
    };
  }
}

export function buildMixedFleet(opts: {
  openai?: AgentBackendConfig[];
  sarvam?: AgentBackendConfig[];
  local?: AgentBackendConfig[];
  groq?: AgentBackendConfig[];
  together?: AgentBackendConfig[];
}): HonestLLMProvider[] {
  const configs = [
    ...(opts.openai ?? []),
    ...(opts.sarvam ?? []),
    ...(opts.local ?? []),
    ...(opts.groq ?? []),
    ...(opts.together ?? []),
  ];
  return configs.map((c) => new HonestLLMProvider(c));
}

export class MaliciousLLMProvider {
  constructor(
    private readonly id: string,
    private readonly strategy: "null_output" | "degraded" | "selective_default",
    private readonly defaultProbabilityOnHighValue: number = 0.8
  ) {}

  get providerId(): string {
    return this.id;
  }

  async executeTask(
    task: TaskRequest,
    jobPrice: number,
    medianPrice: number
  ): Promise<{ output: string | null; didDefault: boolean }> {
    void task;
    if (this.strategy === "null_output") {
      return { output: null, didDefault: true };
    }
    if (this.strategy === "selective_default" && medianPrice > 0 && jobPrice > medianPrice * 1.2) {
      const defaults = Math.random() < this.defaultProbabilityOnHighValue;
      return defaults ? { output: null, didDefault: true } : { output: "degraded output", didDefault: false };
    }
    return { output: "This is a plausible but incorrect response.", didDefault: false };
  }
}
