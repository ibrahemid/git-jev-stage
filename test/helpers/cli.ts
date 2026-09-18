import type { CliIo } from "../../src/cli/main.js";

export interface TestIoOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
  isStdinTty?: boolean;
  isStdoutTty?: boolean;
  answers?: readonly string[];
}

export interface TestIo {
  io: CliIo;
  stdout: () => string;
  stderr: () => string;
  bytes: () => Buffer;
  pending: () => number;
}

export function createTestIo(options: TestIoOptions): TestIo {
  const out: string[] = [];
  const err: string[] = [];
  const chunks: Buffer[] = [];
  const answers = [...(options.answers ?? [])];

  const io: CliIo = {
    stdout: (text) => {
      out.push(text);
    },
    stderr: (text) => {
      err.push(text);
    },
    stdoutBytes: (buffer) => {
      chunks.push(Buffer.from(buffer));
    },
    isStdoutTty: options.isStdoutTty ?? false,
    isStdinTty: options.isStdinTty ?? false,
    readLine: () => Promise.resolve(answers.shift()),
    cwd: options.cwd,
    env: options.env ?? {},
  };

  return {
    io,
    stdout: () => out.join(""),
    stderr: () => err.join(""),
    bytes: () => Buffer.concat(chunks),
    pending: () => answers.length,
  };
}
