export const ExitCode = {
  success: 0,
  usage: 2,
  repository: 3,
  scan: 4,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

export class PaperbotError extends Error {
  readonly exit_code: ExitCode;

  constructor(message: string, exit_code: ExitCode) {
    super(message);
    this.name = "PaperbotError";
    this.exit_code = exit_code;
  }
}
