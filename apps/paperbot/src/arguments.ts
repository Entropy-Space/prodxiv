import { ExitCode, PaperbotError } from "./errors.ts";

export type OutputFormat = "text" | "json";
export type ValidationProfile = "draft" | "submission" | "publication";

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

export interface PublishArguments {
  command: "publish";
  input_path: string;
  format: OutputFormat;
  yes: boolean;
}

export interface SkillsArguments {
  command: "skills";
  scope?: string;
  component?: string;
  format: OutputFormat;
}

export type AuthArguments =
  | {
      command: "auth";
      action: "init";
    }
  | {
      command: "auth";
      action: "set";
      api_url: string;
      site_url?: string;
      token_stdin: boolean;
    }
  | {
      command: "auth";
      action: "status" | "remove";
    };

export type ParsedArguments =
  | ScanArguments
  | ValidateArguments
  | DraftArguments
  | PublishArguments
  | SkillsArguments
  | AuthArguments
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
  if (args[0] === "publish") {
    return parsePublishArguments(args.slice(1));
  }
  if (args[0] === "skills") {
    return parseSkillsArguments(args.slice(1));
  }
  if (args[0] === "auth") {
    return parseAuthArguments(args.slice(1));
  }
  throw usageError(`unknown command: ${args[0]}`);
}

function parseSkillsArguments(
  args: string[],
): SkillsArguments | { command: "help" } {
  const positionals: string[] = [];
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
    if (argument.startsWith("-")) {
      throw usageError(`unknown option: ${argument}`);
    }
    positionals.push(argument);
  }

  if (positionals.length > 2) {
    throw usageError("skills accepts at most one scope and one component");
  }

  const scope = positionals[0];
  const component = positionals[1];
  return {
    command: "skills",
    ...(scope === undefined ? {} : { scope }),
    ...(component === undefined ? {} : { component }),
    format,
  };
}

function parsePublishArguments(
  args: string[],
): PublishArguments | { command: "help" } {
  let input_path: string | undefined;
  let format: OutputFormat = "text";
  let yes = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) {
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      return { command: "help" };
    }
    if (argument === "--yes") {
      yes = true;
      continue;
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
    if (argument.startsWith("-")) {
      throw usageError(`unknown option: ${argument}`);
    }
    if (input_path !== undefined) {
      throw usageError("publish accepts only one paper path");
    }
    input_path = argument;
  }

  if (input_path === undefined) {
    throw usageError("publish requires a paper path");
  }
  return {
    command: "publish",
    input_path,
    format,
    yes,
  };
}

function parseAuthArguments(
  args: string[],
): AuthArguments | { command: "help" } {
  const action = args[0];
  if (action === undefined || action === "init") {
    if (args.length > 1) {
      throw usageError("auth init does not accept options");
    }
    return { command: "auth", action: "init" };
  }
  if (action === "--help" || action === "-h") {
    return { command: "help" };
  }
  if (action === "status" || action === "remove") {
    if (args.length !== 1) {
      throw usageError(`auth ${action} does not accept options`);
    }
    return { command: "auth", action };
  }
  if (action !== "set") {
    throw usageError("auth requires one of: init, set, status, remove");
  }

  let api_url: string | undefined;
  let site_url: string | undefined;
  let token_stdin = false;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--token-stdin") {
      token_stdin = true;
      continue;
    }
    if (argument === "--api-url") {
      const value = args[index + 1];
      if (value === undefined || value.length === 0) {
        throw usageError("missing value for --api-url");
      }
      api_url = value;
      index += 1;
      continue;
    }
    if (argument?.startsWith("--api-url=")) {
      api_url = requiredInlineValue(argument, "--api-url");
      continue;
    }
    if (argument === "--site-url") {
      const value = args[index + 1];
      if (value === undefined || value.length === 0) {
        throw usageError("missing value for --site-url");
      }
      site_url = value;
      index += 1;
      continue;
    }
    if (argument?.startsWith("--site-url=")) {
      site_url = requiredInlineValue(argument, "--site-url");
      continue;
    }
    throw usageError(`unknown option: ${argument}`);
  }
  if (api_url === undefined) {
    throw usageError("auth set requires --api-url");
  }
  return {
    command: "auth",
    action: "set",
    api_url,
    ...(site_url === undefined ? {} : { site_url }),
    token_stdin,
  };
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
  if (value === "draft" || value === "submission" || value === "publication") {
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
