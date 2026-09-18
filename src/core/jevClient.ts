import process from "node:process";
import {
  APIConnectionError,
  APIError,
  type ChoiceQuestion,
  choice,
  type EntryType,
  type Fetch,
  type RequestOptions,
  TypeSafeClient,
  type TypeSafeClientConfig,
} from "@typesafe-ai/sdk";
import { ProviderConfigError, ProviderError } from "./errors.js";
import type {
  AnswerOutcome,
  ClassifyRequest,
  ClassifyResult,
  JevProvider,
  JsonValue,
} from "./types.js";

const DEFAULT_MODEL = "jev-latest";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 2;

export interface TypeSafeJevProviderOptions {
  apiKey?: string | undefined;
  baseURL?: string | undefined;
  model?: string | undefined;
  timeoutMs?: number | undefined;
  maxRetries?: number | undefined;
  fetch?: Fetch | undefined;
}

export class TypeSafeJevProvider implements JevProvider {
  readonly model: string;
  readonly #client: TypeSafeClient;

  constructor(options: TypeSafeJevProviderOptions = {}) {
    const apiKey = options.apiKey?.trim() ?? "";
    if (apiKey.length === 0) {
      throw new ProviderConfigError("TYPESAFE_API_KEY is not set");
    }
    const model = options.model?.trim() ?? "";
    this.model = model.length > 0 ? model : DEFAULT_MODEL;

    const config: TypeSafeClientConfig = {
      apiKey,
      logLevel: "off",
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      retry: { maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES },
    };
    const baseURL = options.baseURL?.trim() ?? "";
    if (baseURL.length > 0) {
      config.baseURL = baseURL;
    }
    if (options.fetch !== undefined) {
      config.fetch = options.fetch;
    }
    this.#client = createClient(config);
  }

  async classify<L extends string>(
    request: ClassifyRequest<L>,
    options?: { signal?: AbortSignal },
  ): Promise<ClassifyResult<L>> {
    const specs = Object.entries(request.questions);
    if (specs.length === 0) {
      return { outcomes: {}, usage: { inputTokens: 0, outputTokens: 0 }, model: this.model };
    }

    const questions: Record<string, ChoiceQuestion> = {};
    for (const [id, spec] of specs) {
      questions[id] = choice(spec.instructions, { ...spec.options });
    }
    const requestOptions: RequestOptions =
      options?.signal === undefined ? {} : { signal: options.signal };

    let payload: unknown;
    let requestId: string | undefined;
    try {
      const response = await this.#client
        .systemOne(
          { state: toStatePayload(request.state), questions, model: this.model },
          requestOptions,
        )
        .withResponse();
      payload = response.data;
      requestId = response.requestId;
    } catch (error) {
      throw toProviderError(error);
    }

    const answers = readAnswers(payload);
    const outcomes: Record<string, AnswerOutcome<L>> = {};
    for (const [id, spec] of specs) {
      const raw = answers[id];
      outcomes[id] =
        raw === undefined
          ? { kind: "missing" }
          : validateChoiceAnswer(raw, Object.keys(spec.options) as L[]);
    }

    return {
      outcomes,
      usage: readUsage(payload),
      model: readModel(payload) ?? this.model,
      ...(requestId === undefined ? {} : { requestId }),
    };
  }
}

export function createProviderFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): TypeSafeJevProvider | undefined {
  const apiKey = env.TYPESAFE_API_KEY?.trim() ?? "";
  if (apiKey.length === 0) {
    return undefined;
  }
  const baseURL = env.TYPESAFE_BASE_URL?.trim() ?? "";
  return new TypeSafeJevProvider({ apiKey, ...(baseURL.length > 0 ? { baseURL } : {}) });
}

export function validateChoiceAnswer<L extends string = string>(
  raw: unknown,
  options: readonly L[],
): AnswerOutcome<L> {
  const labels: readonly string[] = options;
  if (!isRecord(raw)) {
    return { kind: "invalid", reason: "answer is not an object" };
  }
  if (raw.type !== "choice") {
    return { kind: "invalid", reason: "answer type is not choice" };
  }
  const selected = raw.choice;
  if (typeof selected !== "string" || !labels.includes(selected)) {
    return { kind: "invalid", reason: "choice is not one of the options" };
  }
  const confidence = raw.confidence;
  if (!isProbability(confidence)) {
    return { kind: "invalid", reason: "confidence is not a number between 0 and 1" };
  }
  const rawProbabilities = raw.probabilities;
  if (!isRecord(rawProbabilities)) {
    return { kind: "invalid", reason: "probabilities is not an object" };
  }
  const probabilities: Record<string, number> = {};
  for (const [label, probability] of Object.entries(rawProbabilities)) {
    if (!labels.includes(label)) {
      return { kind: "invalid", reason: "probabilities has a label that is not an option" };
    }
    if (!isProbability(probability)) {
      return {
        kind: "invalid",
        reason: "probabilities has a value that is not a number between 0 and 1",
      };
    }
    probabilities[label] = probability;
  }
  return {
    kind: "answer",
    answer: {
      choice: selected as L,
      confidence,
      probabilities: probabilities as Record<L, number>,
    },
  };
}

function createClient(config: TypeSafeClientConfig): TypeSafeClient {
  try {
    return new TypeSafeClient(config);
  } catch (error) {
    throw new ProviderConfigError("the TypeSafe client rejected its configuration", {
      cause: error,
    });
  }
}

function toProviderError(error: unknown): ProviderError {
  if (error instanceof APIError) {
    return new ProviderError(`TypeSafe request failed (${error.status})`, {
      status: error.status,
      requestId: error.requestId,
      retryable: error.status === 429 || error.status >= 500,
      cause: error,
    });
  }
  if (error instanceof APIConnectionError) {
    return new ProviderError("TypeSafe request failed (network)", {
      retryable: true,
      cause: error,
    });
  }
  return new ProviderError("TypeSafe request failed (network)", {
    retryable: false,
    cause: error,
  });
}

function toStatePayload(state: JsonValue): EntryType {
  if (typeof state === "number" || typeof state === "boolean") {
    return String(state);
  }
  return state;
}

function readAnswers(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload)) {
    return {};
  }
  const answers = payload.answers;
  return isRecord(answers) ? answers : {};
}

function readUsage(payload: unknown): { inputTokens: number; outputTokens: number } {
  if (!isRecord(payload)) {
    return { inputTokens: 0, outputTokens: 0 };
  }
  const usage = payload.usage;
  if (!isRecord(usage)) {
    return { inputTokens: 0, outputTokens: 0 };
  }
  return {
    inputTokens: readCount(usage.input_tokens),
    outputTokens: readCount(usage.output_tokens),
  };
}

function readCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function readModel(payload: unknown): string | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const model = payload.model;
  return typeof model === "string" && model.length > 0 ? model : undefined;
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
