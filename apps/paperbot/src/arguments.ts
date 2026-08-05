import {
  ExitCode,
  PaperbotError,
  type ValidationProfile,
} from "@prodxiv/paperbot-core";

export type OutputFormat = "text" | "json";
export type { ValidationProfile } from "@prodxiv/paperbot-core";
export type AgentPaperStatus =
  "concept" | "private_beta" | "public_beta" | "launched" | "discontinued";

export interface PublishArguments {
  command: "publish";
  input_path: string;
  format: OutputFormat;
  yes: boolean;
  product_id?: string;
}

export interface SkillsArguments {
  command: "skills";
  scope?: string;
  component?: string;
  format: OutputFormat;
}

export type ToolsAction =
  | "list"
  | "describe"
  | "repo_scan"
  | "paper_scaffold"
  | "paper_validate"
  | "help";

export interface ToolsListArguments {
  command: "tools";
  action: "list";
}

export interface ToolsDescribeArguments {
  command: "tools";
  action: "describe";
  tool_name: string;
}

export interface ToolsRepoScanArguments {
  command: "tools";
  action: "repo_scan";
  repository_path: string;
  format: OutputFormat;
  exclusions: string[];
  inclusions: string[];
}

export interface ToolsPaperScaffoldArguments {
  command: "tools";
  action: "paper_scaffold";
  scan_path: string;
  title?: string;
  format: OutputFormat;
}

export interface ToolsPaperValidateArguments {
  command: "tools";
  action: "paper_validate";
  input_path: string;
  profile: ValidationProfile;
  format: OutputFormat;
}

export type ToolsArguments =
  | ToolsListArguments
  | ToolsDescribeArguments
  | ToolsRepoScanArguments
  | ToolsPaperScaffoldArguments
  | ToolsPaperValidateArguments
  | {
      command: "tools";
      action: "help";
    };

export interface AgentRunArguments {
  command: "agent";
  action: "run";
  repository: string;
  output_path: string;
  allow_remote_model: boolean;
  metadata: {
    title: string;
    product_name: string;
    authors: string[];
    status: AgentPaperStatus;
    product_url?: string;
    repository_url?: string;
  };
  external_sources: string[];
  ref?: string;
  model?: string;
  format: OutputFormat;
}

export interface AgentResumeArguments {
  command: "agent";
  action: "resume";
  run_path: string;
  answers_path: string;
  allow_remote_model: boolean;
  model?: string;
  format: OutputFormat;
}

export interface AgentBatchArguments {
  command: "agent";
  action: "batch";
  input_path: string;
  output_path: string;
  allow_remote_model: boolean;
  authors?: string[];
  status?: AgentPaperStatus;
  model?: string;
  concurrency?: number;
  format: OutputFormat;
}

export interface AgentSelectTrendingArguments {
  command: "agent";
  action: "select-trending";
  output_path: string;
  allow_remote_model: boolean;
  api_url?: string;
  snapshot_path?: string;
  model?: string;
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
  | PublishArguments
  | SkillsArguments
  | ToolsArguments
  | AgentRunArguments
  | AgentResumeArguments
  | AgentBatchArguments
  | AgentSelectTrendingArguments
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
  if (args[0] === "publish") {
    return parsePublishArguments(args.slice(1));
  }
  if (args[0] === "skills") {
    return parseSkillsArguments(args.slice(1));
  }
  if (args[0] === "tools") {
    return parseToolsArguments(args.slice(1));
  }
  if (args[0] === "auth") {
    return parseAuthArguments(args.slice(1));
  }
  if (args[0] === "agent") {
    return parseAgentArguments(args.slice(1));
  }
  throw usageError(`unknown command: ${args[0]}`);
}

function parseAgentArguments(
  args: string[],
):
  | AgentRunArguments
  | AgentResumeArguments
  | AgentBatchArguments
  | AgentSelectTrendingArguments
  | { command: "help" } {
  const action = args[0];
  if (action === "--help" || action === "-h") {
    return { command: "help" };
  }
  if (action === "run") {
    return parseAgentRunArguments(args.slice(1));
  }
  if (action === "resume") {
    return parseAgentResumeArguments(args.slice(1));
  }
  if (action === "batch") {
    return parseAgentBatchArguments(args.slice(1));
  }
  if (action === "select-trending") {
    return parseAgentSelectTrendingArguments(args.slice(1));
  }
  throw usageError(
    "agent requires one of: run, resume, batch, select-trending",
  );
}

function parseAgentRunArguments(
  args: string[],
): AgentRunArguments | { command: "help" } {
  let repository: string | undefined;
  let output_path: string | undefined;
  let title: string | undefined;
  let product_name: string | undefined;
  let product_url: string | undefined;
  let repository_url: string | undefined;
  let status: AgentPaperStatus | undefined;
  let ref: string | undefined;
  let model: string | undefined;
  let format: OutputFormat = "text";
  let allow_remote_model = false;
  const authors: string[] = [];
  const external_sources: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) {
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      return { command: "help" };
    }
    if (argument === "--allow-remote-model") {
      allow_remote_model = true;
      continue;
    }
    if (argument === "--format") {
      const value = requiredFollowingValue(args, index, "--format");
      format = parseFormat(value);
      index += 1;
      continue;
    }
    if (argument.startsWith("--format=")) {
      format = parseFormat(requiredInlineValue(argument, "--format"));
      continue;
    }
    if (argument === "--status") {
      status = parseAgentStatus(
        requiredFollowingValue(args, index, "--status"),
      );
      index += 1;
      continue;
    }
    if (argument.startsWith("--status=")) {
      status = parseAgentStatus(requiredInlineValue(argument, "--status"));
      continue;
    }

    const option = parseAgentStringOption(argument);
    if (option !== undefined) {
      const value =
        option.inline_value ?? requiredFollowingValue(args, index, option.name);
      if (option.inline_value === undefined) {
        index += 1;
      }
      if (option.name === "--output") {
        output_path = value;
      } else if (option.name === "--title") {
        title = value;
      } else if (option.name === "--product-name") {
        product_name = value;
      } else if (option.name === "--product-url") {
        product_url = value;
      } else if (option.name === "--repository-url") {
        repository_url = value;
      } else if (option.name === "--author") {
        authors.push(value);
      } else if (option.name === "--source") {
        external_sources.push(value);
      } else if (option.name === "--ref") {
        ref = value;
      } else {
        model = value;
      }
      continue;
    }
    if (argument.startsWith("-")) {
      throw usageError(`unknown option: ${argument}`);
    }
    if (repository !== undefined) {
      throw usageError("agent run accepts only one repository path or URL");
    }
    repository = argument;
  }

  if (repository === undefined) {
    throw usageError("agent run requires a repository path or URL");
  }
  if (output_path === undefined) {
    throw usageError("agent run requires --output");
  }
  if (authors.length === 0) {
    throw usageError("agent run requires at least one --author");
  }
  if (status === undefined) {
    throw usageError("agent run requires --status");
  }
  if (!allow_remote_model) {
    throw usageError(
      "agent run requires --allow-remote-model before source content is sent to a model",
    );
  }

  const defaultProductName = defaultAgentProductName(repository);
  return {
    command: "agent",
    action: "run",
    repository,
    output_path,
    allow_remote_model,
    metadata: {
      title: title ?? `${defaultProductName} research draft`,
      product_name: product_name ?? defaultProductName,
      authors,
      status,
      ...(product_url === undefined ? {} : { product_url }),
      ...(repository_url === undefined ? {} : { repository_url }),
    },
    external_sources,
    ...(ref === undefined ? {} : { ref }),
    ...(model === undefined ? {} : { model }),
    format,
  };
}

function parseAgentResumeArguments(
  args: string[],
): AgentResumeArguments | { command: "help" } {
  let run_path: string | undefined;
  let answers_path: string | undefined;
  let model: string | undefined;
  let format: OutputFormat = "text";
  let allow_remote_model = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) {
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      return { command: "help" };
    }
    if (argument === "--allow-remote-model") {
      allow_remote_model = true;
      continue;
    }
    if (argument === "--format") {
      format = parseFormat(requiredFollowingValue(args, index, "--format"));
      index += 1;
      continue;
    }
    if (argument.startsWith("--format=")) {
      format = parseFormat(requiredInlineValue(argument, "--format"));
      continue;
    }
    if (argument === "--answers") {
      answers_path = requiredFollowingValue(args, index, "--answers");
      index += 1;
      continue;
    }
    if (argument.startsWith("--answers=")) {
      answers_path = requiredInlineValue(argument, "--answers");
      continue;
    }
    if (argument === "--model") {
      model = requiredFollowingValue(args, index, "--model");
      index += 1;
      continue;
    }
    if (argument.startsWith("--model=")) {
      model = requiredInlineValue(argument, "--model");
      continue;
    }
    if (argument.startsWith("-")) {
      throw usageError(`unknown option: ${argument}`);
    }
    if (run_path !== undefined) {
      throw usageError("agent resume accepts only one run directory");
    }
    run_path = argument;
  }

  if (run_path === undefined) {
    throw usageError("agent resume requires a run directory");
  }
  if (answers_path === undefined) {
    throw usageError("agent resume requires --answers");
  }
  if (!allow_remote_model) {
    throw usageError(
      "agent resume requires --allow-remote-model before source content is sent to a model",
    );
  }
  return {
    command: "agent",
    action: "resume",
    run_path,
    answers_path,
    allow_remote_model,
    ...(model === undefined ? {} : { model }),
    format,
  };
}

function parseAgentBatchArguments(
  args: string[],
): AgentBatchArguments | { command: "help" } {
  let input_path: string | undefined;
  let output_path: string | undefined;
  let status: AgentPaperStatus | undefined;
  let model: string | undefined;
  let concurrency: number | undefined;
  let format: OutputFormat = "text";
  let allow_remote_model = false;
  const authors: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) {
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      return { command: "help" };
    }
    if (argument === "--allow-remote-model") {
      allow_remote_model = true;
      continue;
    }
    if (argument === "--format") {
      format = parseFormat(requiredFollowingValue(args, index, "--format"));
      index += 1;
      continue;
    }
    if (argument.startsWith("--format=")) {
      format = parseFormat(requiredInlineValue(argument, "--format"));
      continue;
    }
    if (argument === "--status") {
      status = parseAgentStatus(
        requiredFollowingValue(args, index, "--status"),
      );
      index += 1;
      continue;
    }
    if (argument.startsWith("--status=")) {
      status = parseAgentStatus(requiredInlineValue(argument, "--status"));
      continue;
    }
    if (argument === "--output") {
      output_path = requiredFollowingValue(args, index, "--output");
      index += 1;
      continue;
    }
    if (argument.startsWith("--output=")) {
      output_path = requiredInlineValue(argument, "--output");
      continue;
    }
    if (argument === "--author") {
      authors.push(requiredFollowingValue(args, index, "--author"));
      index += 1;
      continue;
    }
    if (argument.startsWith("--author=")) {
      authors.push(requiredInlineValue(argument, "--author"));
      continue;
    }
    if (argument === "--model") {
      model = requiredFollowingValue(args, index, "--model");
      index += 1;
      continue;
    }
    if (argument.startsWith("--model=")) {
      model = requiredInlineValue(argument, "--model");
      continue;
    }
    if (argument === "--concurrency") {
      concurrency = parseAgentConcurrency(
        requiredFollowingValue(args, index, "--concurrency"),
      );
      index += 1;
      continue;
    }
    if (argument.startsWith("--concurrency=")) {
      concurrency = parseAgentConcurrency(
        requiredInlineValue(argument, "--concurrency"),
      );
      continue;
    }
    if (argument.startsWith("-")) {
      throw usageError(`unknown option: ${argument}`);
    }
    if (input_path !== undefined) {
      throw usageError("agent batch accepts only one manifest path");
    }
    input_path = argument;
  }

  if (input_path === undefined) {
    throw usageError("agent batch requires a manifest path");
  }
  if (output_path === undefined) {
    throw usageError("agent batch requires --output");
  }
  if (!allow_remote_model) {
    throw usageError(
      "agent batch requires --allow-remote-model before source content is sent to a model",
    );
  }

  return {
    command: "agent",
    action: "batch",
    input_path,
    output_path,
    allow_remote_model,
    ...(authors.length === 0 ? {} : { authors }),
    ...(status === undefined ? {} : { status }),
    ...(model === undefined ? {} : { model }),
    ...(concurrency === undefined ? {} : { concurrency }),
    format,
  };
}

function parseAgentSelectTrendingArguments(
  args: string[],
): AgentSelectTrendingArguments | { command: "help" } {
  let output_path: string | undefined;
  let api_url: string | undefined;
  let snapshot_path: string | undefined;
  let model: string | undefined;
  let format: OutputFormat = "text";
  let allow_remote_model = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) {
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      return { command: "help" };
    }
    if (argument === "--allow-remote-model") {
      allow_remote_model = true;
      continue;
    }
    if (argument === "--output") {
      output_path = requiredFollowingValue(args, index, "--output");
      index += 1;
      continue;
    }
    if (argument.startsWith("--output=")) {
      output_path = requiredInlineValue(argument, "--output");
      continue;
    }
    if (argument === "--api-url") {
      api_url = requiredFollowingValue(args, index, "--api-url");
      index += 1;
      continue;
    }
    if (argument.startsWith("--api-url=")) {
      api_url = requiredInlineValue(argument, "--api-url");
      continue;
    }
    if (argument === "--snapshot") {
      snapshot_path = requiredFollowingValue(args, index, "--snapshot");
      index += 1;
      continue;
    }
    if (argument.startsWith("--snapshot=")) {
      snapshot_path = requiredInlineValue(argument, "--snapshot");
      continue;
    }
    if (argument === "--model") {
      model = requiredFollowingValue(args, index, "--model");
      index += 1;
      continue;
    }
    if (argument.startsWith("--model=")) {
      model = requiredInlineValue(argument, "--model");
      continue;
    }
    if (argument === "--format") {
      format = parseFormat(requiredFollowingValue(args, index, "--format"));
      index += 1;
      continue;
    }
    if (argument.startsWith("--format=")) {
      format = parseFormat(requiredInlineValue(argument, "--format"));
      continue;
    }
    if (argument.startsWith("-")) {
      throw usageError(`unknown option: ${argument}`);
    }
    throw usageError("agent select-trending does not accept positional inputs");
  }

  if (output_path === undefined) {
    throw usageError("agent select-trending requires --output");
  }
  if (!allow_remote_model) {
    throw usageError(
      "agent select-trending requires --allow-remote-model before the public trend snapshot is sent to a model",
    );
  }
  if (api_url !== undefined && snapshot_path !== undefined) {
    throw usageError(
      "agent select-trending accepts either --snapshot or --api-url, not both",
    );
  }
  return {
    command: "agent",
    action: "select-trending",
    output_path,
    allow_remote_model,
    ...(api_url === undefined ? {} : { api_url }),
    ...(snapshot_path === undefined ? {} : { snapshot_path }),
    ...(model === undefined ? {} : { model }),
    format,
  };
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

function parseToolsArguments(args: string[]): ToolsArguments {
  const action = args[0];
  if (action === undefined) {
    return { command: "tools", action: "list" };
  }
  if (action === "--help" || action === "-h" || action === "help") {
    if (args.length !== 1) {
      throw usageError("tools help does not accept options");
    }
    return { command: "tools", action: "help" };
  }
  if (action === "list") {
    if (args.length !== 1) {
      throw usageError("tools list does not accept options");
    }
    return { command: "tools", action: "list" };
  }

  if (action === "describe") {
    if (args.length !== 2 || args[1] === undefined || args[1].startsWith("-")) {
      throw usageError("tools describe requires exactly one tool name");
    }
    return { command: "tools", action: "describe", tool_name: args[1] };
  }

  if (action === "repo_scan") {
    return parseToolsRepoScanArguments(args.slice(1));
  }
  if (action === "paper_scaffold") {
    return parseToolsPaperScaffoldArguments(args.slice(1));
  }
  if (action === "paper_validate") {
    return parseToolsPaperValidateArguments(args.slice(1));
  }
  throw usageError(
    "tools requires one of: list, describe, repo_scan, paper_scaffold, paper_validate",
  );
}

function parseToolsRepoScanArguments(
  args: string[],
): ToolsRepoScanArguments | { command: "tools"; action: "help" } {
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
      return { command: "tools", action: "help" };
    }
    if (argument === "--format") {
      format = parseFormat(requiredFollowingValue(args, index, "--format"));
      index += 1;
      continue;
    }
    if (argument.startsWith("--format=")) {
      format = parseFormat(requiredInlineValue(argument, "--format"));
      continue;
    }
    if (argument === "--exclude") {
      exclusions.push(requiredFollowingValue(args, index, "--exclude"));
      index += 1;
      continue;
    }
    if (argument.startsWith("--exclude=")) {
      exclusions.push(requiredInlineValue(argument, "--exclude"));
      continue;
    }
    if (argument === "--include") {
      inclusions.push(requiredFollowingValue(args, index, "--include"));
      index += 1;
      continue;
    }
    if (argument.startsWith("--include=")) {
      inclusions.push(requiredInlineValue(argument, "--include"));
      continue;
    }
    if (argument.startsWith("-")) {
      throw usageError(`unknown tools repo_scan option: ${argument}`);
    }
    if (hasRepositoryPath) {
      throw usageError("tools repo_scan accepts only one repository path");
    }
    repository_path = argument;
    hasRepositoryPath = true;
  }

  return {
    command: "tools",
    action: "repo_scan",
    repository_path,
    format,
    exclusions,
    inclusions,
  };
}

function parseToolsPaperScaffoldArguments(
  args: string[],
): ToolsPaperScaffoldArguments | { command: "tools"; action: "help" } {
  let scan_path: string | undefined;
  let title: string | undefined;
  let format: OutputFormat = "text";

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) {
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      return { command: "tools", action: "help" };
    }
    if (argument === "--format") {
      format = parseFormat(requiredFollowingValue(args, index, "--format"));
      index += 1;
      continue;
    }
    if (argument.startsWith("--format=")) {
      format = parseFormat(requiredInlineValue(argument, "--format"));
      continue;
    }
    if (argument === "--title") {
      title = requiredFollowingValue(args, index, "--title");
      index += 1;
      continue;
    }
    if (argument.startsWith("--title=")) {
      title = requiredInlineValue(argument, "--title");
      continue;
    }
    if (argument.startsWith("-")) {
      throw usageError(`unknown tools paper_scaffold option: ${argument}`);
    }
    if (scan_path !== undefined) {
      throw usageError(
        "tools paper_scaffold accepts only one scan manifest path",
      );
    }
    scan_path = argument;
  }

  if (scan_path === undefined) {
    throw usageError("tools paper_scaffold requires a scan manifest path");
  }
  return {
    command: "tools",
    action: "paper_scaffold",
    scan_path,
    ...(title === undefined ? {} : { title }),
    format,
  };
}

function parseToolsPaperValidateArguments(
  args: string[],
): ToolsPaperValidateArguments | { command: "tools"; action: "help" } {
  let input_path: string | undefined;
  let profile: ValidationProfile = "draft";
  let format: OutputFormat = "text";

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) {
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      return { command: "tools", action: "help" };
    }
    if (argument === "--format") {
      format = parseFormat(requiredFollowingValue(args, index, "--format"));
      index += 1;
      continue;
    }
    if (argument.startsWith("--format=")) {
      format = parseFormat(requiredInlineValue(argument, "--format"));
      continue;
    }
    if (argument === "--profile") {
      profile = parseProfile(requiredFollowingValue(args, index, "--profile"));
      index += 1;
      continue;
    }
    if (argument.startsWith("--profile=")) {
      profile = parseProfile(requiredInlineValue(argument, "--profile"));
      continue;
    }
    if (argument.startsWith("-")) {
      throw usageError(`unknown tools paper_validate option: ${argument}`);
    }
    if (input_path !== undefined) {
      throw usageError("tools paper_validate accepts only one paper path");
    }
    input_path = argument;
  }

  if (input_path === undefined) {
    throw usageError("tools paper_validate requires a paper path");
  }
  return {
    command: "tools",
    action: "paper_validate",
    input_path,
    profile,
    format,
  };
}

function parsePublishArguments(
  args: string[],
): PublishArguments | { command: "help" } {
  let input_path: string | undefined;
  let format: OutputFormat = "text";
  let yes = false;
  let product_id: string | undefined;

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
    if (argument === "--product-id") {
      const value = args[index + 1];
      if (value === undefined || value.length === 0) {
        throw usageError("missing value for --product-id");
      }
      product_id = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--product-id=")) {
      product_id = argument.slice("--product-id=".length);
      if (product_id.length === 0) {
        throw usageError("missing value for --product-id");
      }
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
    ...(product_id === undefined ? {} : { product_id }),
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

const AGENT_STRING_OPTIONS = [
  "--output",
  "--title",
  "--product-name",
  "--product-url",
  "--repository-url",
  "--author",
  "--source",
  "--ref",
  "--model",
] as const;

type AgentStringOptionName = (typeof AGENT_STRING_OPTIONS)[number];

interface ParsedAgentStringOption {
  name: AgentStringOptionName;
  inline_value?: string;
}

function parseAgentStringOption(
  argument: string,
): ParsedAgentStringOption | undefined {
  for (const option of AGENT_STRING_OPTIONS) {
    if (argument === option) {
      return { name: option };
    }
    if (argument.startsWith(`${option}=`)) {
      return {
        name: option,
        inline_value: requiredInlineValue(argument, option),
      };
    }
  }
  return undefined;
}

function requiredFollowingValue(
  args: string[],
  index: number,
  option: string,
): string {
  const value = args[index + 1];
  if (value === undefined || value.length === 0) {
    throw usageError(`missing value for ${option}`);
  }
  return value;
}

function defaultAgentProductName(repository: string): string {
  const withoutSuffix = repository
    .trim()
    .replace(/[\\/]+$/, "")
    .replace(/\.git$/i, "");
  const candidate = withoutSuffix.split(/[\\/]/).at(-1);
  if (
    candidate === undefined ||
    candidate.length === 0 ||
    candidate === "." ||
    candidate === ".."
  ) {
    return "Repository";
  }
  return candidate;
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

function parseAgentStatus(value: string): AgentPaperStatus {
  if (
    value === "concept" ||
    value === "private_beta" ||
    value === "public_beta" ||
    value === "launched" ||
    value === "discontinued"
  ) {
    return value;
  }
  throw usageError(`unsupported product status: ${value}`);
}

function parseAgentConcurrency(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw usageError("agent batch --concurrency must be a positive integer");
  }
  const concurrency = Number(value);
  if (!Number.isSafeInteger(concurrency)) {
    throw usageError("agent batch --concurrency must be a safe integer");
  }
  return concurrency;
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
