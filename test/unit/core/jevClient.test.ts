import type { Fetch } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";
import type { ChoiceSpec, ClassifyRequest } from "../../../src/core/index.js";
import {
  createProviderFromEnv,
  ProviderConfigError,
  ProviderError,
  TypeSafeJevProvider,
  validateChoiceAnswer,
} from "../../../src/core/index.js";

type Label = "include" | "exclude" | "mixed";

const SPEC: ChoiceSpec<Label> = {
  instructions: "Does hunk h1 belong to the described change?",
  options: {
    include: "every changed line in this hunk belongs to the described change",
    exclude: "no changed line in this hunk belongs to the described change",
    mixed: "some changed lines belong and some do not",
  },
};
const LABELS: Label[] = ["include", "exclude", "mixed"];

function request(ids: readonly string[]): ClassifyRequest<Label> {
  const questions: Record<string, ChoiceSpec<Label>> = {};
  for (const id of ids) {
    questions[id] = SPEC;
  }
  return { state: { intent: "fix auth", files: [] }, questions };
}

function answer(choice: Label, confidence: number): Record<string, unknown> {
  return {
    type: "choice",
    choice,
    confidence,
    probabilities: { include: 0.2, exclude: 0.3, mixed: 0.5 },
  };
}

interface Stub {
  fetch: Fetch;
  bodies: string[];
}

function stubJson(status: number, payload: unknown, requestId = "req_1"): Stub {
  const bodies: string[] = [];
  return {
    bodies,
    fetch: async (_input, init) => {
      bodies.push(typeof init?.body === "string" ? init.body : "");
      return new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json", "x-typesafe-request-id": requestId },
      });
    },
  };
}

function stubThrows(error: Error): Stub {
  const bodies: string[] = [];
  return {
    bodies,
    fetch: async (_input, init) => {
      bodies.push(typeof init?.body === "string" ? init.body : "");
      throw error;
    },
  };
}

function provider(stub: Stub): TypeSafeJevProvider {
  return new TypeSafeJevProvider({ apiKey: "test-key", fetch: stub.fetch, maxRetries: 0 });
}

describe("TypeSafeJevProvider", () => {
  it("maps answers, usage, model and request id", async () => {
    const stub = stubJson(200, {
      model: "jev-2026-09",
      answers: { h1: answer("include", 0.94), h2: answer("exclude", 0.71) },
      usage: { input_tokens: 1234, output_tokens: 7 },
    });

    const result = await provider(stub).classify(request(["h1", "h2"]));

    expect(result.outcomes).toEqual({
      h1: {
        kind: "answer",
        answer: {
          choice: "include",
          confidence: 0.94,
          probabilities: { include: 0.2, exclude: 0.3, mixed: 0.5 },
        },
      },
      h2: {
        kind: "answer",
        answer: {
          choice: "exclude",
          confidence: 0.71,
          probabilities: { include: 0.2, exclude: 0.3, mixed: 0.5 },
        },
      },
    });
    expect(result.usage).toEqual({ inputTokens: 1234, outputTokens: 7 });
    expect(result.model).toBe("jev-2026-09");
    expect(result.requestId).toBe("req_1");
  });

  it("sends one choice question per id with the model", async () => {
    const stub = stubJson(200, { model: "m", answers: {}, usage: {} });
    await provider(stub).classify(request(["h1"]));

    const sent: unknown = JSON.parse(stub.bodies[0] ?? "{}");
    expect(sent).toMatchObject({
      model: "jev-latest",
      state: { intent: "fix auth" },
      questions: {
        h1: { type: "choice", instructions: SPEC.instructions, criteria: SPEC.options },
      },
    });
  });

  it("ignores extra ids and reports absent ids as missing", async () => {
    const stub = stubJson(200, {
      model: "m",
      answers: { h1: answer("mixed", 0.5), extra: answer("include", 1) },
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    const result = await provider(stub).classify(request(["h1", "h2"]));

    expect(Object.keys(result.outcomes)).toEqual(["h1", "h2"]);
    expect(result.outcomes.h2).toEqual({ kind: "missing" });
  });

  it("reports a malformed answer as invalid", async () => {
    const stub = stubJson(200, {
      model: "m",
      answers: { h1: { type: "choice", choice: "include", confidence: 4, probabilities: {} } },
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    const result = await provider(stub).classify(request(["h1"]));

    expect(result.outcomes.h1).toEqual({
      kind: "invalid",
      reason: "confidence is not a number between 0 and 1",
    });
  });

  it("survives an envelope without answers or usage", async () => {
    const stub = stubJson(200, {});
    const result = await provider(stub).classify(request(["h1"]));

    expect(result.outcomes.h1).toEqual({ kind: "missing" });
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(result.model).toBe("jev-latest");
  });

  it("returns early without a request when there are no questions", async () => {
    const stub = stubJson(200, {});
    const result = await provider(stub).classify({ state: "x", questions: {} });

    expect(result).toEqual({
      outcomes: {},
      usage: { inputTokens: 0, outputTokens: 0 },
      model: "jev-latest",
    });
    expect(stub.bodies).toEqual([]);
  });

  it("maps 401 to a non-retryable provider error", async () => {
    const stub = stubJson(401, { error: "bad key" });
    const error = await provider(stub)
      .classify(request(["h1"]))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({
      message: "TypeSafe request failed (401)",
      status: 401,
      requestId: "req_1",
      retryable: false,
    });
    expect(stub.bodies).toHaveLength(1);
  });

  it("maps 429 and 500 to retryable provider errors", async () => {
    for (const status of [429, 500]) {
      const stub = stubJson(status, { error: "slow down" });
      const error = await provider(stub)
        .classify(request(["h1"]))
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ProviderError);
      expect(error).toMatchObject({
        message: `TypeSafe request failed (${status})`,
        status,
        retryable: true,
      });
      expect(stub.bodies).toHaveLength(1);
    }
  });

  it("maps a timeout to a retryable provider error", async () => {
    const fetchStub: Fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    const timed = new TypeSafeJevProvider({
      apiKey: "test-key",
      fetch: fetchStub,
      timeoutMs: 20,
      maxRetries: 0,
    });

    const error = await timed.classify(request(["h1"])).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({
      message: "TypeSafe request failed (network)",
      status: undefined,
      retryable: true,
    });
  });

  it("maps a connection failure to a retryable provider error", async () => {
    const stub = stubThrows(new Error("socket hang up"));
    const error = await provider(stub)
      .classify(request(["h1"]))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({
      message: "TypeSafe request failed (network)",
      status: undefined,
      retryable: true,
    });
  });

  it("maps a caller abort to a non-retryable provider error", async () => {
    const controller = new AbortController();
    controller.abort();
    const stub = stubThrows(new Error("aborted"));

    const error = await provider(stub)
      .classify(request(["h1"]), { signal: controller.signal })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ retryable: false, status: undefined });
  });

  it("never leaks state or question text into an error", async () => {
    const stub = stubJson(500, { error: "boom" });
    const error = await provider(stub)
      .classify(request(["h1"]))
      .catch((caught: unknown) => caught);

    expect(String(error)).not.toContain("fix auth");
    expect(String(error)).not.toContain(SPEC.instructions);
  });

  it("rejects construction without a key", () => {
    expect(() => new TypeSafeJevProvider()).toThrow(ProviderConfigError);
    expect(() => new TypeSafeJevProvider({ apiKey: "   " })).toThrow(ProviderConfigError);
  });
});

describe("createProviderFromEnv", () => {
  it("returns undefined without a key", () => {
    expect(createProviderFromEnv({})).toBeUndefined();
    expect(createProviderFromEnv({ TYPESAFE_API_KEY: "" })).toBeUndefined();
    expect(createProviderFromEnv({ TYPESAFE_API_KEY: "  " })).toBeUndefined();
  });

  it("builds a provider from the environment", () => {
    const built = createProviderFromEnv({
      TYPESAFE_API_KEY: "k",
      TYPESAFE_BASE_URL: "https://example.test",
    });

    expect(built).toBeInstanceOf(TypeSafeJevProvider);
    expect(built?.model).toBe("jev-latest");
  });
});

describe("validateChoiceAnswer", () => {
  it("accepts a well formed answer", () => {
    expect(validateChoiceAnswer(answer("mixed", 0), LABELS)).toEqual({
      kind: "answer",
      answer: {
        choice: "mixed",
        confidence: 0,
        probabilities: { include: 0.2, exclude: 0.3, mixed: 0.5 },
      },
    });
  });

  it("accepts probabilities that cover only some options", () => {
    const raw = { type: "choice", choice: "include", confidence: 1, probabilities: { include: 1 } };
    expect(validateChoiceAnswer(raw, LABELS)).toEqual({
      kind: "answer",
      answer: { choice: "include", confidence: 1, probabilities: { include: 1 } },
    });
  });

  it.each([
    ["non-object", 7, "answer is not an object"],
    ["null", null, "answer is not an object"],
    ["array", [1], "answer is not an object"],
    ["wrong type", { ...answer("include", 0.5), type: "noul" }, "answer type is not choice"],
    [
      "no type",
      { choice: "include", confidence: 0.5, probabilities: {} },
      "answer type is not choice",
    ],
    [
      "unknown option",
      { ...answer("include", 0.5), choice: "maybe" },
      "choice is not one of the options",
    ],
    [
      "non-string choice",
      { ...answer("include", 0.5), choice: 3 },
      "choice is not one of the options",
    ],
    [
      "confidence above one",
      { ...answer("include", 0.5), confidence: 1.5 },
      "confidence is not a number between 0 and 1",
    ],
    [
      "confidence NaN",
      { ...answer("include", 0.5), confidence: Number.NaN },
      "confidence is not a number between 0 and 1",
    ],
    [
      "confidence string",
      { ...answer("include", 0.5), confidence: "0.5" },
      "confidence is not a number between 0 and 1",
    ],
    [
      "probabilities missing",
      { type: "choice", choice: "include", confidence: 0.5 },
      "probabilities is not an object",
    ],
    [
      "probabilities not an object",
      { ...answer("include", 0.5), probabilities: [0.5] },
      "probabilities is not an object",
    ],
    [
      "probabilities with an unknown label",
      { ...answer("include", 0.5), probabilities: { include: 0.5, maybe: 0.5 } },
      "probabilities has a label that is not an option",
    ],
    [
      "probabilities with a non-numeric value",
      { ...answer("include", 0.5), probabilities: { include: "high" } },
      "probabilities has a value that is not a number between 0 and 1",
    ],
    [
      "probabilities out of range",
      { ...answer("include", 0.5), probabilities: { include: 2 } },
      "probabilities has a value that is not a number between 0 and 1",
    ],
  ])("rejects %s", (_name, raw, reason) => {
    expect(validateChoiceAnswer(raw, LABELS)).toEqual({ kind: "invalid", reason });
  });
});
