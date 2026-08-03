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
import {
  findSkillComponent,
  findSkillScope,
  skillCatalog,
} from "./skill-catalog.ts";
import { ExitCode, PaperbotError } from "@prodxiv/paperbot-core";

export const TOOL_SCHEMA_VERSION = "1" as const;

export type ToolName =
  | "repository_scan"
  | "paper_scaffold"
  | "paper_validate"
  | "skill_catalog"
  | "skill_read"
  | "prompt_catalog";
export type ToolCaller = "agent_host" | "automation";
export type ToolSideEffect = "none" | "local_read";

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
  callers: readonly ToolCaller[];
  human_commands: readonly string[];
  side_effects: readonly ToolSideEffect[];
  network_access: false;
  input_schema: ToolSchema;
  output_schema: ToolSchema;
}

export const toolCatalog = [
  {
    name: "repository_scan",
    description: "Select and classify safe files from a local Git repository.",
    callers: ["agent_host", "automation"],
    human_commands: ["scan"],
    side_effects: ["local_read"],
    network_access: false,
    input_schema: {
      type: "object",
      properties: {
        repository_path: {
          type: "string",
          description: "Path to the Git worktree to inspect.",
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
      },
      required: ["repository_path"],
      additional_properties: false,
    },
    output_schema: objectSchema(),
  },
  {
    name: "paper_scaffold",
    description: "Create a section-complete Markdown paper scaffold.",
    callers: ["agent_host", "automation"],
    human_commands: ["draft"],
    side_effects: ["local_read"],
    network_access: false,
    input_schema: {
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
      },
      required: ["scan_path"],
      additional_properties: false,
    },
    output_schema: objectSchema(),
  },
  {
    name: "paper_validate",
    description: "Validate a paper against the canonical schema and rules.",
    callers: ["agent_host", "automation"],
    human_commands: ["validate"],
    side_effects: ["local_read"],
    network_access: false,
    input_schema: {
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
      },
      required: ["input_path"],
      additional_properties: false,
    },
    output_schema: objectSchema(),
  },
  {
    name: "skill_catalog",
    description: "List the progressive-disclosure Paperbot skill scopes.",
    callers: ["agent_host", "automation"],
    human_commands: ["skills"],
    side_effects: ["none"],
    network_access: false,
    input_schema: emptySchema(),
    output_schema: objectSchema(),
  },
  {
    name: "skill_read",
    description: "Read one Paperbot skill scope or component.",
    callers: ["agent_host", "automation"],
    human_commands: ["skills"],
    side_effects: ["none"],
    network_access: false,
    input_schema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          description: "Skill scope to read.",
          enum: ["project", "paper", "publication"],
        },
        component: {
          type: "string",
          description: "Optional component within the scope.",
        },
      },
      required: ["scope"],
      additional_properties: false,
    },
    output_schema: objectSchema(),
  },
  {
    name: "prompt_catalog",
    description: "List the deterministic prompt phases used by the agent host.",
    callers: ["agent_host", "automation"],
    human_commands: [],
    side_effects: ["none"],
    network_access: false,
    input_schema: emptySchema(),
    output_schema: objectSchema(),
  },
] as const satisfies readonly ToolDescriptor[];

export type ToolRequest = {
  schema_version: typeof TOOL_SCHEMA_VERSION;
  arguments: Record<string, unknown>;
};

export interface ToolSuccess {
  schema_version: typeof TOOL_SCHEMA_VERSION;
  tool_name: ToolName;
  ok: true;
  result: unknown;
}

export interface ToolFailure {
  schema_version: typeof TOOL_SCHEMA_VERSION;
  tool_name: string;
  ok: false;
  error: {
    message: string;
    exit_code: number;
  };
}

export type ToolResult = ToolSuccess | ToolFailure;

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

export interface SkillReadInput {
  scope: string;
  component?: string;
}

export function findTool(name: string): ToolDescriptor | undefined {
  return toolCatalog.find((tool) => tool.name === name);
}

export function parseToolRequest(value: unknown): ToolRequest {
  if (!isRecord(value)) {
    throw usageError("tool input must be a JSON object");
  }
  assertAllowedKeys(value, ["schema_version", "arguments"], "tool input");
  if (value.schema_version !== TOOL_SCHEMA_VERSION) {
    throw usageError(
      `tool input schema_version must be ${TOOL_SCHEMA_VERSION}`,
    );
  }
  if (!isRecord(value.arguments)) {
    throw usageError("tool input arguments must be a JSON object");
  }
  return {
    schema_version: TOOL_SCHEMA_VERSION,
    arguments: value.arguments,
  };
}

export async function executeTool(
  name: string,
  input: unknown,
): Promise<ToolSuccess> {
  const tool = findTool(name);
  if (tool === undefined) {
    throw usageError(
      `unknown tool: ${name}; expected one of: ${toolCatalog.map(({ name: toolName }) => toolName).join(", ")}`,
    );
  }
  const request = parseToolRequest(input);
  const result = await executeToolArguments(tool.name, request.arguments);
  return {
    schema_version: TOOL_SCHEMA_VERSION,
    tool_name: tool.name,
    ok: true,
    result,
  };
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

export function getSkillCatalog(): Record<string, unknown> {
  return {
    schema_version: TOOL_SCHEMA_VERSION,
    scopes: skillCatalog.map(({ scope, description }) => ({
      scope,
      description,
    })),
  };
}

export function getSkillRead(input: SkillReadInput): Record<string, unknown> {
  const scope = findSkillScope(input.scope);
  if (scope === undefined) {
    throw usageError(
      `unknown skill scope: ${input.scope}; expected one of: ${skillCatalog.map((entry) => entry.scope).join(", ")}`,
    );
  }
  if (input.component === undefined) {
    return {
      schema_version: TOOL_SCHEMA_VERSION,
      scope: scope.scope,
      description: scope.description,
      instructions: scope.instructions.trim(),
      components: scope.components.map(({ component, description }) => ({
        component,
        description,
      })),
    };
  }
  const component = findSkillComponent(scope.scope, input.component);
  if (component === undefined) {
    throw usageError(
      `unknown ${scope.scope} skill component: ${input.component}; expected one of: ${scope.components.map((entry) => entry.component).join(", ")}`,
    );
  }
  return {
    schema_version: TOOL_SCHEMA_VERSION,
    scope: scope.scope,
    component: component.component,
    description: component.description,
    instructions: component.instructions.trim(),
  };
}

export function getPromptCatalog(): Record<string, unknown> {
  return {
    schema_version: TOOL_SCHEMA_VERSION,
    prompts: [
      {
        prompt_name: "draft",
        description: "Create an evidence-backed private paper draft.",
        agent_phase: "drafting",
      },
      {
        prompt_name: "review",
        description: "Review a private draft for unsupported or unsafe claims.",
        agent_phase: "review",
      },
      {
        prompt_name: "repair",
        description: "Apply one bounded repair pass to a reviewed draft.",
        agent_phase: "repair",
      },
    ],
  };
}

async function executeToolArguments(
  name: ToolName,
  value: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "repository_scan":
      return runRepositoryScan(parseRepositoryScanInput(value));
    case "paper_scaffold":
      return runPaperScaffold(parsePaperScaffoldInput(value));
    case "paper_validate":
      return runPaperValidation(parsePaperValidateInput(value));
    case "skill_catalog":
      assertEmptyInput(value, name);
      return getSkillCatalog();
    case "skill_read":
      return getSkillRead(parseSkillReadInput(value));
    case "prompt_catalog":
      assertEmptyInput(value, name);
      return getPromptCatalog();
  }
}

function parseRepositoryScanInput(
  value: Record<string, unknown>,
): RepositoryScanInput {
  assertAllowedKeys(
    value,
    ["repository_path", "exclusions", "inclusions"],
    "repository_scan",
  );
  return {
    repository_path: requiredString(value, "repository_path"),
    exclusions: optionalStringArray(value, "exclusions"),
    inclusions: optionalStringArray(value, "inclusions"),
  };
}

function parsePaperScaffoldInput(
  value: Record<string, unknown>,
): PaperScaffoldInput {
  assertAllowedKeys(value, ["scan_path", "title"], "paper_scaffold");
  const title = optionalString(value, "title");
  return {
    scan_path: requiredString(value, "scan_path"),
    ...(title === undefined ? {} : { title }),
  };
}

function parsePaperValidateInput(
  value: Record<string, unknown>,
): PaperValidateInput {
  assertAllowedKeys(value, ["input_path", "profile"], "paper_validate");
  const profile = value.profile ?? "draft";
  if (
    profile !== "draft" &&
    profile !== "submission" &&
    profile !== "publication"
  ) {
    throw usageError(
      "paper_validate profile must be draft, submission, or publication",
    );
  }
  return {
    input_path: requiredString(value, "input_path"),
    profile,
  };
}

function parseSkillReadInput(value: Record<string, unknown>): SkillReadInput {
  assertAllowedKeys(value, ["scope", "component"], "skill_read");
  const component = optionalString(value, "component");
  return {
    scope: requiredString(value, "scope"),
    ...(component === undefined ? {} : { component }),
  };
}

function assertEmptyInput(
  value: Record<string, unknown>,
  toolName: ToolName,
): void {
  assertAllowedKeys(value, [], toolName);
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) {
    throw usageError(`${label} does not accept argument: ${unknown}`);
  }
}

function requiredString(value: Record<string, unknown>, field: string): string {
  const result = value[field];
  if (typeof result !== "string" || result.length === 0) {
    throw usageError(`tool argument ${field} must be a non-empty string`);
  }
  return result;
}

function optionalString(
  value: Record<string, unknown>,
  field: string,
): string | undefined {
  const result = value[field];
  if (result === undefined) {
    return undefined;
  }
  if (typeof result !== "string" || result.length === 0) {
    throw usageError(`tool argument ${field} must be a non-empty string`);
  }
  return result;
}

function optionalStringArray(
  value: Record<string, unknown>,
  field: string,
): string[] {
  const result = value[field];
  if (result === undefined) {
    return [];
  }
  if (
    !Array.isArray(result) ||
    result.some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    throw usageError(`tool argument ${field} must be an array of strings`);
  }
  return [...result];
}

function objectSchema(): ToolSchema {
  return {
    type: "object",
    properties: {},
    required: [],
    additional_properties: false,
  };
}

function emptySchema(): ToolSchema {
  return objectSchema();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function usageError(message: string): PaperbotError {
  return new PaperbotError(message, ExitCode.usage);
}
