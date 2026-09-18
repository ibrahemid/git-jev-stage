import { readFileSync } from "node:fs";
import { ProviderConfigError, ProviderError } from "./errors.js";
import { validateChoiceAnswer } from "./jevClient.js";
import type {
  AnswerOutcome,
  ChoiceAnswer,
  ChoiceSpec,
  ClassifyRequest,
  ClassifyResult,
  JevProvider,
} from "./types.js";

export type ScriptedAnswer = ChoiceAnswer | { raw: unknown };

export interface FakeScript {
  answers?: Record<string, ScriptedAnswer>;
  defaultAnswer?: ChoiceAnswer;
  error?: Error;
  delayMs?: number;
  onRequest?: (request: ClassifyRequest) => void;
}

export class FakeProvider implements JevProvider {
  readonly requests: ClassifyRequest[] = [];
  readonly #script: FakeScript;

  constructor(script: FakeScript = {}) {
    this.#script = script;
  }

  async classify<L extends string>(
    request: ClassifyRequest<L>,
    options?: { signal?: AbortSignal },
  ): Promise<ClassifyResult<L>> {
    const recorded = widenRequest(request);
    this.requests.push(recorded);
    this.#script.onRequest?.(recorded);

    const delayMs = this.#script.delayMs ?? 0;
    if (delayMs > 0) {
      await delay(delayMs);
    }
    options?.signal?.throwIfAborted();

    const scriptedError = this.#script.error;
    if (scriptedError !== undefined) {
      throw scriptedError;
    }

    const outcomes: Record<string, AnswerOutcome<L>> = {};
    for (const [id, spec] of Object.entries(request.questions)) {
      const scripted = this.#script.answers?.[id] ?? this.#script.defaultAnswer;
      outcomes[id] =
        scripted === undefined
          ? { kind: "missing" }
          : validateChoiceAnswer(toPayload(scripted), Object.keys(spec.options) as L[]);
    }

    return { outcomes, usage: { inputTokens: 0, outputTokens: 0 }, model: "fake" };
  }

  static fromJsonFile(path: string): FakeProvider {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      throw new ProviderConfigError(`the fake provider script at ${path} could not be read`, {
        cause: error,
      });
    }
    if (!isRecord(parsed)) {
      throw new ProviderConfigError(`the fake provider script at ${path} is not an object`);
    }

    const script: FakeScript = {};
    const answers = parsed.answers;
    if (answers !== undefined) {
      if (!isRecord(answers)) {
        throw new ProviderConfigError(`answers in ${path} is not an object`);
      }
      const scripted: Record<string, ScriptedAnswer> = {};
      for (const [id, value] of Object.entries(answers)) {
        scripted[id] = toScriptedAnswer(value);
      }
      script.answers = scripted;
    }

    const defaultAnswer = parsed.defaultAnswer;
    if (defaultAnswer !== undefined) {
      const answer = isRecord(defaultAnswer) ? toChoiceAnswer(defaultAnswer) : undefined;
      if (answer === undefined) {
        throw new ProviderConfigError(`defaultAnswer in ${path} is not a choice answer`);
      }
      script.defaultAnswer = answer;
    }

    const errorMessage = parsed.errorMessage;
    if (errorMessage !== undefined) {
      if (typeof errorMessage !== "string" || errorMessage.length === 0) {
        throw new ProviderConfigError(`errorMessage in ${path} is not a non-empty string`);
      }
      script.error = new ProviderError(errorMessage, { retryable: false });
    }

    return new FakeProvider(script);
  }
}

function toPayload(scripted: ScriptedAnswer): unknown {
  if ("raw" in scripted) {
    return scripted.raw;
  }
  return {
    type: "choice",
    choice: scripted.choice,
    confidence: scripted.confidence,
    probabilities: scripted.probabilities,
  };
}

function toScriptedAnswer(value: unknown): ScriptedAnswer {
  if (!isRecord(value)) {
    return { raw: value };
  }
  if ("raw" in value) {
    return { raw: value.raw };
  }
  return toChoiceAnswer(value) ?? { raw: value };
}

function toChoiceAnswer(value: Record<string, unknown>): ChoiceAnswer | undefined {
  const selected = value.choice;
  const confidence = value.confidence;
  const rawProbabilities = value.probabilities;
  if (typeof selected !== "string" || typeof confidence !== "number") {
    return undefined;
  }
  if (!isRecord(rawProbabilities)) {
    return undefined;
  }
  const probabilities: Record<string, number> = {};
  for (const [label, probability] of Object.entries(rawProbabilities)) {
    if (typeof probability !== "number") {
      return undefined;
    }
    probabilities[label] = probability;
  }
  return { choice: selected, confidence, probabilities };
}

function widenRequest<L extends string>(request: ClassifyRequest<L>): ClassifyRequest {
  const questions: Record<string, ChoiceSpec> = {};
  for (const [id, spec] of Object.entries(request.questions)) {
    questions[id] = { instructions: spec.instructions, options: { ...spec.options } };
  }
  return { state: request.state, questions };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
