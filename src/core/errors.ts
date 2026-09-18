export interface ProviderErrorOptions extends ErrorOptions {
  status?: number | undefined;
  requestId?: string | undefined;
  retryable?: boolean | undefined;
}

export abstract class JevCoreError extends Error {
  abstract readonly code: string;
}

export class ProviderError extends JevCoreError {
  readonly code = "provider";
  readonly status: number | undefined;
  readonly requestId: string | undefined;
  readonly retryable: boolean;

  constructor(message: string, options?: ProviderErrorOptions) {
    super(message, options);
    this.name = "ProviderError";
    this.status = options?.status;
    this.requestId = options?.requestId;
    this.retryable = options?.retryable ?? false;
  }
}

export class RequestTooLargeError extends JevCoreError {
  readonly code = "request-too-large";
  readonly estimatedTokens: number;
  readonly tokenCeiling: number;

  constructor(estimatedTokens: number, tokenCeiling: number, options?: ErrorOptions) {
    super(
      `the request needs about ${estimatedTokens} tokens, over the ceiling of ${tokenCeiling}`,
      options,
    );
    this.name = "RequestTooLargeError";
    this.estimatedTokens = estimatedTokens;
    this.tokenCeiling = tokenCeiling;
  }
}

export class ProviderConfigError extends JevCoreError {
  readonly code = "provider-config";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProviderConfigError";
  }
}
