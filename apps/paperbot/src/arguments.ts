import { ExitCode, PaperbotError } from "./errors.ts";

export type OutputFormat = "text" | "json";
export type ValidationProfile = "draft" | "publication";

export interface ScanArguments {
  command: "scan";
  repository_path: string;
  format: OutputFormat;
  exclusions: string[];
  inclusions: string[];
}

export interface ValidateArguments {
  command: "validate";
  input_path: string;
  profile: ValidationProfile;
  format: OutputFormat;
}

export interface DraftArguments {
  command: "draft";
  scan_path: string;
  output_path?: string;
  title?: string;
}

export type ParsedArguments =
  | ScanArguments
  | ValidateArguments
  | DraftArguments
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
  if (args[0] === "scan") {
    return parseScanArguments(args.slice(1));
  }
  if (args[0] === "validate") {
    return parseValidateArguments(args.slice(1));
  }
  if (args[0] === "draft") {
    return parseDraftArguments(args.slice(1));
  }
  throw usageError(`unknown command: ${args[0]}`);
}

function parseDraftArguments(
  args: string[],
): DraftArguments | { command: "help" } {
  let scan_path: string | undefined;
  let output_path: string | undefined;
  let title: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) {
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      return { command: "help" };
    }
    if (argument === "--output" || argument === "--title") {
      const value = args[index + 1];
      if (value === undefined || value.length === 0) {
        throw usageError(`missing value for ${argument}`);
      }
      if (argument === "--output") {
        output_path = value;
      } else {
        title = value;
      }
      index += 1;
      continue;
    }
    if (argument.startsWith("--output=")) {
      output_path = requiredInlineValue(argument, "--output");
      continue;
    }
    if (argument.startsWith("--title=")) {
      title = requiredInlineValue(argument, "--title");
      continue;
    }
    if (argument.startsWith("-")) {
      throw usageError(`unknown option: ${argument}`);
    }
    if (scan_path !== undefined) {
      throw usageError("draft accepts only one scan manifest path");
    }
    scan_path = argument;
  }

  if (scan_path === undefined) {
    throw usageError("draft requires a scan manifest path");
  }
  return {
    command: "draft",
    scan_path,
    ...(output_path === undefined ? {} : { output_path }),
    ...(title === undefined ? {} : { title }),
  };
}

function parseScanArguments(
  args: string[],
): ScanArguments | { command: "help" } {
  let repository_path = ".";
  let hasRepositoryPath = false;
  let format: OutputFormat = "text";
  const exclusions: string[] = [];
  const inclusions: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
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

function parseValidateArguments(
  args: string[],
): ValidateArguments | { command: "help" } {
  let input_path: string | undefined;
  let profile: ValidationProfile = "draft";
  let format: OutputFormat = "text";

  for (let index = 0; index < args.length; index += 1) {
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
    if (argument === "--profile") {
      const value = args[index + 1];
      if (value === undefined) {
        throw usageError("missing value for --profile");
      }
      profile = parseProfile(value);
      index += 1;
      continue;
    }
    if (argument.startsWith("--profile=")) {
      profile = parseProfile(argument.slice("--profile=".length));
      continue;
    }
    if (argument.startsWith("-")) {
      throw usageError(`unknown option: ${argument}`);
    }
    if (input_path !== undefined) {
      throw usageError("validate accepts only one paper path");
    }
    input_path = argument;
  }

  if (input_path === undefined) {
    throw usageError("validate requires a paper path");
  }
  return {
    command: "validate",
    input_path,
    profile,
    format,
  };
}

function parseFormat(value: string): OutputFormat {
  if (value === "text" || value === "json") {
    return value;
  }
  throw usageError(`unsupported output format: ${value}`);
}

function parseProfile(value: string): ValidationProfile {
  if (value === "draft" || value === "publication") {
    return value;
  }
  throw usageError(`unsupported validation profile: ${value}`);
}

function requiredInlineValue(argument: string, option: string): string {
  const value = argument.slice(`${option}=`.length);
  if (value.length === 0) {
    throw usageError(`missing value for ${option}`);
  }
  return value;
}

function usageError(message: string): PaperbotError {
  return new PaperbotError(message, ExitCode.usage);
}
