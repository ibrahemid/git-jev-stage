import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ChoiceAnswer, ChoiceSpec, ClassifyRequest } from "../../../src/core/index.js";
import { FakeProvider, ProviderConfigError, ProviderError } from "../../../src/core/index.js";

type Label = "include" | "exclude" | "mixed";

const SPEC: ChoiceSpec<Label> = {
  instructions: "Does hunk h1 belong to the described change?",
  options: { include: "belongs", exclude: "does not belong", mixed: "partly belongs" },
};

const INCLUDE: ChoiceAnswer<Label> = {
  choice: "include",
  confidence: 0.9,
  probabilities: { include: 0.9, exclude: 0.05, mixed: 0.05 },
};

const workDirs: string[] = [];

function request(ids: readonly string[]): ClassifyRequest<Label> {
  const questions: Record<string, ChoiceSpec<Label>> = {};
  for (const id of ids) {
    questions[id] = SPEC;
  }
  return { state: { intent: "fix auth" }, questions };
}

function scriptFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "jev-fake-"));
  workDirs.push(dir);
  const path = join(dir, "script.json");
  writeFileSync(path, contents);
  return path;
}

afterAll(() => {
  for (const dir of workDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("FakeProvider", () => {
  it("reports unscripted ids as missing", async () => {
    const result = await new FakeProvider().classify(request(["h1", "h2"]));

    expect(result.outcomes).toEqual({ h1: { kind: "missing" }, h2: { kind: "missing" } });
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(result.model).toBe("fake");
  });

  it("answers scripted ids and falls back to the default answer", async () => {
    const provider = new FakeProvider({
      answers: { h1: { ...INCLUDE, choice: "exclude" } },
      defaultAnswer: INCLUDE,
    });

    const result = await provider.classify(request(["h1", "h2"]));

    expect(result.outcomes.h1).toEqual({
      kind: "answer",
      answer: { ...INCLUDE, choice: "exclude" },
    });
    expect(result.outcomes.h2).toEqual({ kind: "answer", answer: INCLUDE });
  });

  it("runs a raw payload through the shared validation", async () => {
    const provider = new FakeProvider({
      answers: {
        h1: { raw: { type: "choice", choice: "nope", confidence: 1, probabilities: {} } },
        h2: {
          raw: { type: "choice", choice: "mixed", confidence: 0.4, probabilities: { mixed: 1 } },
        },
      },
    });

    const result = await provider.classify(request(["h1", "h2"]));

    expect(result.outcomes.h1).toEqual({
      kind: "invalid",
      reason: "choice is not one of the options",
    });
    expect(result.outcomes.h2).toEqual({
      kind: "answer",
      answer: { choice: "mixed", confidence: 0.4, probabilities: { mixed: 1 } },
    });
  });

  it("throws the scripted error", async () => {
    const failure = new ProviderError("TypeSafe request failed (500)", { retryable: true });
    const provider = new FakeProvider({ error: failure });

    await expect(provider.classify(request(["h1"]))).rejects.toBe(failure);
    expect(provider.requests).toHaveLength(1);
  });

  it("records every request and notifies the hook", async () => {
    const seen: ClassifyRequest[] = [];
    const provider = new FakeProvider({ onRequest: (recorded) => seen.push(recorded) });

    await provider.classify(request(["h1"]));
    await provider.classify(request(["h2", "h3"]));

    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[0]).toEqual({
      state: { intent: "fix auth" },
      questions: { h1: { instructions: SPEC.instructions, options: SPEC.options } },
    });
    expect(Object.keys(provider.requests[1]?.questions ?? {})).toEqual(["h2", "h3"]);
    expect(seen).toEqual(provider.requests);
  });

  it("waits for the scripted delay and honors an abort", async () => {
    const controller = new AbortController();
    const provider = new FakeProvider({ delayMs: 10, defaultAnswer: INCLUDE });
    const pending = provider.classify(request(["h1"]), { signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toThrow();
  });

  it("loads a script from json", async () => {
    const path = scriptFile(
      JSON.stringify({
        answers: {
          h1: { choice: "exclude", confidence: 0.8, probabilities: { exclude: 0.8, include: 0.2 } },
          h2: { raw: { type: "choice", choice: "include", confidence: 5, probabilities: {} } },
        },
        defaultAnswer: INCLUDE,
      }),
    );

    const result = await FakeProvider.fromJsonFile(path).classify(request(["h1", "h2", "h3"]));

    expect(result.outcomes.h1).toEqual({
      kind: "answer",
      answer: { choice: "exclude", confidence: 0.8, probabilities: { exclude: 0.8, include: 0.2 } },
    });
    expect(result.outcomes.h2).toEqual({
      kind: "invalid",
      reason: "confidence is not a number between 0 and 1",
    });
    expect(result.outcomes.h3).toEqual({ kind: "answer", answer: INCLUDE });
  });

  it("turns errorMessage into a provider error", async () => {
    const path = scriptFile(JSON.stringify({ answers: {}, errorMessage: "scripted failure" }));

    await expect(FakeProvider.fromJsonFile(path).classify(request(["h1"]))).rejects.toThrow(
      ProviderError,
    );
  });

  it("rejects an unreadable or malformed script", () => {
    expect(() => FakeProvider.fromJsonFile(join(tmpdir(), "jev-missing-script.json"))).toThrow(
      ProviderConfigError,
    );
    expect(() => FakeProvider.fromJsonFile(scriptFile("{"))).toThrow(ProviderConfigError);
    expect(() => FakeProvider.fromJsonFile(scriptFile("[]"))).toThrow(ProviderConfigError);
    expect(() => FakeProvider.fromJsonFile(scriptFile('{"answers":3}'))).toThrow(
      ProviderConfigError,
    );
    expect(() => FakeProvider.fromJsonFile(scriptFile('{"defaultAnswer":"yes"}'))).toThrow(
      ProviderConfigError,
    );
    expect(() => FakeProvider.fromJsonFile(scriptFile('{"errorMessage":7}'))).toThrow(
      ProviderConfigError,
    );
  });
});
