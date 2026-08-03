import {
  preparePaperDraft,
  type ValidationProfile,
  validatePaperFile,
} from "@prodxiv/paperbot-core";
import {
  scanRepository,
  type ScanOptions,
  type ScanResult,
} from "@prodxiv/paperbot-source";

export const TOOL_SCHEMA_VERSION = "1" as const;

export type ToolName = "repo_scan" | "paper_scaffold" | "paper_validate";
export type ToolCaller = "agent_host" | "automation";
export type ToolSideEffect = "local_read";

export interface ToolSchemaProperty {
  type: "array" | "string";
  description: string;
  items?: {
    type: "string";
  };
  enum?: readonly string[];
}

export interface ToolSchema {
  type: "object";
  properties: Readonly<Record<string, ToolSchemaProperty>>;
  required: readonly string[];
  additional_properties: false;
}

export interface ToolDescriptor {
  name: ToolName;
  description: string;
  invocation: string;
  callers: readonly ToolCaller[];
  human_commands: readonly string[];
  side_effects: readonly ToolSideEffect[];
  network_access: false;
  arguments_schema: ToolSchema;
  output_schema: ToolSchema;
}

export const toolCatalog = [
  {
    name: "repo_scan",
    description: "Select and classify safe files from a local Git repository.",
    invocation:
      "paperbot tools repo_scan [repository] [--exclude <glob>] [--include <glob>] [--format text|json]",
    callers: ["agent_host", "automation"],
    human_commands: ["scan"],
    side_effects: ["local_read"],
    network_access: false,
    arguments_schema: {
      type: "object",
      properties: {
        repository_path: {
          type: "string",
          description: "Optional path to the Git worktree; defaults to .",
        },
        exclusions: {
          type: "array",
          description: "Additional repository-relative glob exclusions.",
          items: { type: "string" },
        },
        inclusions: {
          type: "array",
          description: "Default-excluded globs to opt back into.",
          items: { type: "string" },
        },
        format: {
          type: "string",
          description: "Output format.",
          enum: ["text", "json"],
        },
      },
      required: [],
      additional_properties: false,
    },
    output_schema: objectSchema(),
  },
  {
    name: "paper_scaffold",
    description: "Create a section-complete Markdown paper scaffold.",
    invocation:
      "paperbot tools paper_scaffold <scan.json> [--title <title>] [--format text|json]",
    callers: ["agent_host", "automation"],
    human_commands: ["draft"],
    side_effects: ["local_read"],
    network_access: false,
    arguments_schema: {
      type: "object",
      properties: {
        scan_path: {
          type: "string",
          description: "Path to a versioned scan manifest.",
        },
        title: {
          type: "string",
          description: "Optional initial paper title.",
        },
        format: {
          type: "string",
          description: "Output format.",
          enum: ["text", "json"],
        },
      },
      required: ["scan_path"],
      additional_properties: false,
    },
    output_schema: objectSchema(),
  },
  {
    name: "paper_validate",
    description: "Validate a paper against the canonical schema and rules.",
    invocation:
      "paperbot tools paper_validate <paper.md> [--profile draft|submission|publication] [--format text|json]",
    callers: ["agent_host", "automation"],
    human_commands: ["validate"],
    side_effects: ["local_read"],
    network_access: false,
    arguments_schema: {
      type: "object",
      properties: {
        input_path: {
          type: "string",
          description: "Path to the Markdown paper to validate.",
        },
        profile: {
          type: "string",
          description: "Validation profile to apply.",
          enum: ["draft", "submission", "publication"],
        },
        format: {
          type: "string",
          description: "Output format.",
          enum: ["text", "json"],
        },
      },
      required: ["input_path"],
      additional_properties: false,
    },
    output_schema: objectSchema(),
  },
] as const satisfies readonly ToolDescriptor[];

export interface RepositoryScanInput {
  repository_path: string;
  exclusions: string[];
  inclusions: string[];
}

export interface PaperScaffoldInput {
  scan_path: string;
  title?: string;
}

export interface PaperValidateInput {
  input_path: string;
  profile: ValidationProfile;
}

export function findTool(name: string): ToolDescriptor | undefined {
  return toolCatalog.find((tool) => tool.name === name);
}

export async function runRepositoryScan(
  input: RepositoryScanInput,
): Promise<ScanResult> {
  const options: ScanOptions = {
    exclusions: input.exclusions,
    inclusions: input.inclusions,
  };
  return scanRepository(input.repository_path, options);
}

export async function runPaperScaffold(
  input: PaperScaffoldInput,
): Promise<Awaited<ReturnType<typeof preparePaperDraft>>> {
  return preparePaperDraft(input.scan_path, {
    ...(input.title === undefined ? {} : { title: input.title }),
  });
}

export async function runPaperValidation(
  input: PaperValidateInput,
): Promise<Awaited<ReturnType<typeof validatePaperFile>>> {
  return validatePaperFile(input.input_path, input.profile);
}

function objectSchema(): ToolSchema {
  return {
    type: "object",
    properties: {},
    required: [],
    additional_properties: false,
  };
}
