import { ExitCode, PaperbotError } from "./errors.ts";

export type OutputFormat = "text" | "json";

export interface ScanArguments {
  command: "scan";
  repository_path: string;
  format: OutputFormat;
  exclusions: string[];
  inclusions: string[];
}

export type ParsedArguments =
  | ScanArguments
  | {
      command: "help";
    }
  | {
      command: "version";
    };

export function parseArguments(args: string[]): ParsedArguments {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    return { command: "help" };
  }
  if (args[0] === "--version" || args[0] === "-V") {
    return { command: "version" };
  }
  if (args[0] !== "scan") {
    throw usageError(`unknown command: ${args[0]}`);
  }

  let repository_path = ".";
  let hasRepositoryPath = false;
  let format: OutputFormat = "text";
  const exclusions: string[] = [];
  const inclusions: string[] = [];

  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) {
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      return { command: "help" };
    }
    if (argument === "--format") {
      const value = args[index + 1];
      if (value === undefined) {
        throw usageError("missing value for --format");
      }
      format = parseFormat(value);
      index += 1;
      continue;
    }
    if (argument.startsWith("--format=")) {
      format = parseFormat(argument.slice("--format=".length));
      continue;
    }
    if (argument === "--exclude") {
      const value = args[index + 1];
      if (value === undefined || value.length === 0) {
        throw usageError("missing value for --exclude");
      }
      exclusions.push(value);
      index += 1;
      continue;
    }
    if (argument.startsWith("--exclude=")) {
      const value = argument.slice("--exclude=".length);
      if (value.length === 0) {
        throw usageError("missing value for --exclude");
      }
      exclusions.push(value);
      continue;
    }
    if (argument === "--include") {
      const value = args[index + 1];
      if (value === undefined || value.length === 0) {
        throw usageError("missing value for --include");
      }
      inclusions.push(value);
      index += 1;
      continue;
    }
    if (argument.startsWith("--include=")) {
      const value = argument.slice("--include=".length);
      if (value.length === 0) {
        throw usageError("missing value for --include");
      }
      inclusions.push(value);
      continue;
    }
    if (argument.startsWith("-")) {
      throw usageError(`unknown option: ${argument}`);
    }
    if (hasRepositoryPath) {
      throw usageError("scan accepts only one repository path");
    }
    repository_path = argument;
    hasRepositoryPath = true;
  }

  return {
    command: "scan",
    repository_path,
    format,
    exclusions,
    inclusions,
  };
}

function parseFormat(value: string): OutputFormat {
  if (value === "text" || value === "json") {
    return value;
  }
  throw usageError(`unsupported output format: ${value}`);
}

function usageError(message: string): PaperbotError {
  return new PaperbotError(message, ExitCode.usage);
}
