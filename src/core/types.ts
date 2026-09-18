export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

export interface ChoiceSpec<L extends string = string> {
  instructions: string;
  options: Record<L, string>;
}

export interface ChoiceAnswer<L extends string = string> {
  choice: L;
  confidence: number;
  probabilities: Record<L, number>;
}

export type AnswerOutcome<L extends string = string> =
  | { kind: "answer"; answer: ChoiceAnswer<L> }
  | { kind: "missing" }
  | { kind: "invalid"; reason: string };

export interface ClassifyRequest<L extends string = string> {
  state: JsonValue;
  questions: Record<string, ChoiceSpec<L>>;
}

export interface ClassifyResult<L extends string = string> {
  outcomes: Record<string, AnswerOutcome<L>>;
  usage: { inputTokens: number; outputTokens: number };
  model: string;
  requestId?: string;
}

export interface JevProvider {
  classify<L extends string>(
    request: ClassifyRequest<L>,
    options?: { signal?: AbortSignal },
  ): Promise<ClassifyResult<L>>;
}

export interface WindowItem {
  id: string;
  text: string;
  group: string;
  ordinal: number;
}

export interface Window {
  askIds: string[];
  contextIds: string[];
  estimatedTokens: number;
}

export interface WindowOptions {
  tokenCeiling?: number;
  sharedTokens: number;
  perQuestionTokens?: number;
  neighborContext?: boolean;
}

export interface RunWindowsOptions {
  concurrency?: number;
  signal?: AbortSignal;
}
