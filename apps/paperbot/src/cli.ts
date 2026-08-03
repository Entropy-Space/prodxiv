#!/usr/bin/env bun

import { parseArguments } from "./arguments.ts";
import type { AgentBatchOptions, AgentBatchResult } from "./agent/batch.ts";
import type { ToolsArguments } from "./arguments.ts";
import type { AgentResumeOptions, AgentRunOptions } from "./agent/runner.ts";
import type { AgentRunResult } from "./agent/types.ts";
import {
  ExitCode,
  PaperbotError,
  type DraftPreparation,
  type PaperValidationResult,
  writePaperDraft,
} from "@prodxiv/paperbot-core";
import {
  defaultAuthPath,
  initializeAuth,
  removeAuth,
  resolveAuth,
  saveAuth,
} from "./auth.ts";
import { formatScanResult, formatValidationResult } from "./output.ts";
import { preparePublication } from "./publisher.ts";
import {
  TOOL_SCHEMA_VERSION,
  findTool,
  runPaperScaffold,
  runPaperValidation,
  runRepositoryScan,
  toolCatalog,
} from "./tools.ts";
import {
  findSkillComponent,
  findSkillScope,
  formatSkillCatalog,
  getSkillCatalog,
  getSkillRead,
  skillCatalog,
} from "./skill-catalog.ts";
import { ProdxivApiError } from "@prodxiv/api-client";
import type { ScanResult } from "@prodxiv/paperbot-source";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

const VERSION = "0.0.1";

const HELP = `Paperbot — repository-assisted product paper drafting

Usage:
  paperbot scan [repository] [--format text|json] [--exclude <glob>] [--include <glob>]
  paperbot draft <scan.json> [--title <title>] [--output <paper.md>]
  paperbot validate <paper.md> [--profile draft|submission|publication] [--format text|json]
  paperbot skills [scope] [component] [--format text|json]
  paperbot tools [list]
  paperbot tools describe <tool>
  paperbot tools repo_scan [repository] [--exclude <glob>] [--include <glob>] [--format text|json]
  paperbot tools paper_scaffold <scan.json> [--title <title>] [--format text|json]
  paperbot tools paper_validate <paper.md> [--profile draft|submission|publication] [--format text|json]
  paperbot agent run <repository> --output <run-directory> --author <name> [--author <name> ...] --status <concept|private_beta|public_beta|launched|discontinued> --allow-remote-model [--title <title>] [--product-name <name>] [--product-url <url>] [--repository-url <url>] [--source <url> ...] [--ref <ref>] [--model <model>] [--format text|json]
  paperbot agent resume <run-directory> --answers <answers.md> --allow-remote-model [--model <model>] [--format text|json]
  paperbot agent batch <projects.json> --output <runs-directory> --allow-remote-model [--author <name> ...] [--status <concept|private_beta|public_beta|launched|discontinued>] [--model <model>] [--concurrency <1-4>] [--format text|json]
  paperbot auth [init]
  paperbot auth set --api-url <url> [--site-url <url>] [--token-stdin]
  paperbot auth status
  paperbot auth remove
  paperbot publish <paper.md> [--product-id <id>] [--format text|json] [--yes]
  paperbot --help
  paperbot --version

Human workflows:
  scan      Select relevant repository files into a private scan manifest
  draft     Create a Markdown paper scaffold from a scan manifest
  validate  Validate a product paper
  skills    Discover focused agent guidance by artifact scope and component
  agent     Create or revise a private, evidence-backed paper draft with Pi

Agent-host deterministic tools:
  tools     Discover or run deterministic repository and paper operations

Operator-only remote operations:
  auth      Configure local publishing authentication
  publish   Validate and explicitly publish a product paper

Options:
  --format <format>    Output format: text (default) or json
  --exclude <glob>     Exclude an additional repository-relative glob; repeatable
  --include <glob>     Override a default path exclusion; repeatable
  --output <path>      Write a new draft without overwriting existing work
  --title <title>      Set the initial draft title
  --profile <profile>  Validation profile: draft (default), submission, or publication
  --author <name>      Declare a paper author; repeatable for agent runs
  --status <status>    Product status for an agent run or batch default
  --source <url>       Supply a citeable public URL; Paperbot does not fetch it
  --ref <ref>          Request a GitHub revision for an agent run
  --model <model>      Pi model for an agent run, resume, or batch
  --concurrency <1-4>  Concurrent projects for an agent batch (default: 1)
  --allow-remote-model Explicitly allow the bounded source bundle to leave this machine
  --api-url <url>      Publishing API base URL
  --site-url <url>     Public website base URL for reader links
  --token-stdin        Read the publishing token from stdin
  --product-id <id>    Attach a new paper to an existing product
  --yes                Confirm publication without an interactive prompt
  -h, --help           Show help
  -V, --version        Show version
`;

const TOOLS_HELP = `Paperbot deterministic tools

Usage:
  paperbot tools [list]
  paperbot tools describe <tool>
  paperbot tools repo_scan [repository] [--exclude <glob>] [--include <glob>] [--format text|json]
  paperbot tools paper_scaffold <scan.json> [--title <title>] [--format text|json]
  paperbot tools paper_validate <paper.md> [--profile draft|submission|publication] [--format text|json]

list and describe emit JSON metadata. The deterministic commands accept
normal CLI arguments and emit text by default or versioned JSON with
--format json. JSON is output only; tools do not accept JSON request files.

The JSON output from repo_scan is a scan manifest that can be passed to
paper_scaffold. paper_scaffold --format json includes the report and generated
Markdown. paper_validate --format json emits its validation report.

Publishing and authentication are operator-only commands and are not tools.
Skill discovery belongs to paperbot skills; prompt phases remain internal to
paperbot agent.
`;

export interface CliIo {
  stdout: (message: string) => void;
  stderr: (message: string) => void;
  read_secret?: (prompt: string) => Promise<string>;
  read_stdin?: () => Promise<string>;
  confirm?: (prompt: string) => Promise<boolean>;
}

export interface CliDependencies {
  run_agent?: (options: AgentRunOptions) => Promise<AgentRunResult>;
  resume_agent?: (options: AgentResumeOptions) => Promise<AgentRunResult>;
  run_agent_batch?: (options: AgentBatchOptions) => Promise<AgentBatchResult>;
}

const defaultIo: Required<CliIo> = {
  stdout: (message) => console.log(message),
  stderr: (message) => console.error(message),
  read_secret: readSecret,
  read_stdin: readStdin,
  confirm: confirm,
};

export async function run(
  args: string[],
  io: CliIo = defaultIo,
  dependencies: CliDependencies = {},
): Promise<number> {
  try {
    const parsed = parseArguments(args);
    if (parsed.command === "help") {
      io.stdout(HELP.trimEnd());
      return ExitCode.success;
    }
    if (parsed.command === "version") {
      io.stdout(VERSION);
      return ExitCode.success;
    }

    if (parsed.command === "tools") {
      return await runToolsCommand(parsed, io);
    }

    if (parsed.command === "skills") {
      if (parsed.scope === undefined) {
        io.stdout(
          parsed.format === "json"
            ? JSON.stringify(getSkillCatalog(), null, 2)
            : formatSkillCatalog(),
        );
        return ExitCode.success;
      }

      const scope = findSkillScope(parsed.scope);
      if (scope === undefined) {
        throw new PaperbotError(
          `unknown skill scope: ${parsed.scope}; expected one of: ${skillCatalog.map((entry) => entry.scope).join(", ")}`,
          ExitCode.usage,
        );
      }
      if (parsed.component === undefined) {
        io.stdout(
          parsed.format === "json"
            ? JSON.stringify(getSkillRead(scope.scope), null, 2)
            : scope.instructions.trim(),
        );
        return ExitCode.success;
      }

      const component = findSkillComponent(scope.scope, parsed.component);
      if (component === undefined) {
        throw new PaperbotError(
          `unknown ${scope.scope} skill component: ${parsed.component}; expected one of: ${scope.components.map((entry) => entry.component).join(", ")}`,
          ExitCode.usage,
        );
      }
      io.stdout(
        parsed.format === "json"
          ? JSON.stringify(
              getSkillRead(scope.scope, component.component),
              null,
              2,
            )
          : component.instructions.trim(),
      );
      return ExitCode.success;
    }

    if (parsed.command === "auth") {
      if (parsed.action === "init") {
        const created = await initializeAuth();
        io.stdout(
          created
            ? `Created authentication template: ${defaultAuthPath()}`
            : `Authentication file already exists: ${defaultAuthPath()}`,
        );
        return ExitCode.success;
      }
      if (parsed.action === "set") {
        const token = parsed.token_stdin
          ? await (io.read_stdin ?? defaultIo.read_stdin)()
          : await (io.read_secret ?? defaultIo.read_secret)(
              "Publishing token: ",
            );
        const config = await saveAuth(
          parsed.api_url,
          token,
          undefined,
          parsed.site_url,
        );
        io.stdout(`Saved authentication: ${defaultAuthPath()}`);
        io.stdout(`API: ${config.api_url}`);
        if (config.site_url !== undefined) {
          io.stdout(`Site: ${config.site_url}`);
        }
        return ExitCode.success;
      }
      if (parsed.action === "remove") {
        const removed = await removeAuth();
        io.stdout(
          removed
            ? `Removed authentication: ${defaultAuthPath()}`
            : `Authentication was not configured: ${defaultAuthPath()}`,
        );
        return ExitCode.success;
      }
      const auth = await resolveAuth();
      const fingerprint = new Bun.CryptoHasher("sha256")
        .update(auth.token)
        .digest("hex")
        .slice(0, 12);
      io.stdout(
        [
          "Paperbot authentication",
          `API: ${auth.api_url}`,
          ...(auth.site_url === undefined ? [] : [`Site: ${auth.site_url}`]),
          `Source: ${auth.source}`,
          `Token: configured (${fingerprint})`,
        ].join("\n"),
      );
      return ExitCode.success;
    }

    if (parsed.command === "agent") {
      if (parsed.action === "run") {
        const execute =
          dependencies.run_agent ?? (await loadAgentRunner()).runAgent;
        const result = await execute({
          repository: parsed.repository,
          output_path: parsed.output_path,
          allow_remote_model: parsed.allow_remote_model,
          metadata: parsed.metadata,
          external_sources: parsed.external_sources,
          ...(parsed.ref === undefined ? {} : { ref: parsed.ref }),
          ...(parsed.model === undefined ? {} : { model: parsed.model }),
        });
        writeAgentResult(io, parsed.format, parsed.action, result);
        return result.validation.valid ? ExitCode.success : ExitCode.validation;
      }
      if (parsed.action === "resume") {
        const execute =
          dependencies.resume_agent ?? (await loadAgentRunner()).resumeAgent;
        const result = await execute({
          run_path: parsed.run_path,
          answers_path: parsed.answers_path,
          allow_remote_model: parsed.allow_remote_model,
          ...(parsed.model === undefined ? {} : { model: parsed.model }),
        });
        writeAgentResult(io, parsed.format, parsed.action, result);
        return result.validation.valid ? ExitCode.success : ExitCode.validation;
      }

      const execute =
        dependencies.run_agent_batch ?? (await loadAgentBatch()).runAgentBatch;
      const result = await execute({
        input_path: parsed.input_path,
        output_path: parsed.output_path,
        allow_remote_model: parsed.allow_remote_model,
        ...(parsed.authors === undefined ? {} : { authors: parsed.authors }),
        ...(parsed.status === undefined ? {} : { status: parsed.status }),
        ...(parsed.model === undefined ? {} : { model: parsed.model }),
        ...(parsed.concurrency === undefined
          ? {}
          : { concurrency: parsed.concurrency }),
      });
      writeAgentBatchResult(io, parsed.format, result);
      return result.report.summary.failed === 0
        ? ExitCode.success
        : ExitCode.remote;
    }

    if (parsed.command === "validate") {
      const result = await runPaperValidation({
        input_path: parsed.input_path,
        profile: parsed.profile,
      });
      return writeValidationResult(io, parsed.format, result);
    }

    if (parsed.command === "draft") {
      const result = await runPaperScaffold({
        scan_path: parsed.scan_path,
        ...(parsed.title === undefined ? {} : { title: parsed.title }),
      });
      if (!result.report.valid || result.markdown === undefined) {
        writeDraftDiagnostics(io, result);
        return ExitCode.validation;
      }
      if (parsed.output_path === undefined) {
        io.stdout(result.markdown);
        io.stderr("paperbot: created draft scaffold on stdout");
      } else {
        const outputPath = await writePaperDraft(
          parsed.output_path,
          result.markdown,
        );
        io.stdout(`Created draft: ${outputPath}`);
      }
      return ExitCode.success;
    }

    if (parsed.command === "publish") {
      const preparation = await preparePublication(parsed.input_path, {
        ...(parsed.product_id === undefined
          ? {}
          : { product_id: parsed.product_id }),
      });
      if (
        !preparation.validation.report.valid ||
        preparation.publication === undefined
      ) {
        io.stderr(formatValidationResult(preparation.validation));
        return ExitCode.validation;
      }
      const publication = preparation.publication;
      io.stderr(
        [
          "Paperbot publication",
          `Paper: ${publication.title}`,
          `Input: ${publication.input_path}`,
          `Target: ${publication.api_url}`,
          `Source SHA-256: ${publication.source_sha256}`,
        ].join("\n"),
      );
      if (
        !parsed.yes &&
        !(await (io.confirm ?? defaultIo.confirm)(
          "Publish this immutable paper revision? [y/N] ",
        ))
      ) {
        io.stderr("paperbot: publication cancelled");
        return ExitCode.success;
      }
      const result = await publication.publish();
      if (parsed.format === "json") {
        io.stdout(JSON.stringify(result, null, 2));
        io.stderr(
          `paperbot: ${result.replayed ? "recovered existing" : "created"} ${result.paper_id} v${result.version}`,
        );
      } else {
        io.stdout(
          [
            result.replayed
              ? "Paperbot publication recovered"
              : "Paperbot publication created",
            `Paper: ${result.paper_id} v${result.version}`,
            `Published: ${result.published_at}`,
            `Location: ${result.location}`,
            ...(result.web_url === undefined ? [] : [`Web: ${result.web_url}`]),
            `Source SHA-256: ${result.source_sha256}`,
          ].join("\n"),
        );
      }
      return ExitCode.success;
    }

    if (parsed.command === "scan") {
      const result = await runRepositoryScan({
        repository_path: parsed.repository_path,
        exclusions: parsed.exclusions,
        inclusions: parsed.inclusions,
      });
      return writeScanResult(io, parsed.format, result);
    }

    throw new PaperbotError("unsupported command", ExitCode.usage);
  } catch (error) {
    if (error instanceof ProdxivApiError) {
      io.stderr(`paperbot: ${error.code}: ${error.message}`);
      for (const diagnostic of error.diagnostics) {
        io.stderr(
          `paperbot: [${diagnostic.severity}] ${diagnostic.code} ${diagnostic.path}: ${diagnostic.message}`,
        );
      }
      return error.status === 0 ? ExitCode.network : ExitCode.remote;
    }
    if (error instanceof PaperbotError) {
      io.stderr(`paperbot: ${error.message}`);
      return error.exit_code;
    }
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`paperbot: unexpected failure: ${message}`);
    return ExitCode.scan;
  }
}

async function loadAgentRunner(): Promise<typeof import("./agent/runner.ts")> {
  return import("./agent/runner.ts");
}

async function runToolsCommand(
  parsed: ToolsArguments,
  io: CliIo,
): Promise<number> {
  if (parsed.action === "help") {
    io.stdout(TOOLS_HELP.trimEnd());
    return ExitCode.success;
  }
  if (parsed.action === "list") {
    io.stdout(
      JSON.stringify(
        {
          schema_version: TOOL_SCHEMA_VERSION,
          tools: toolCatalog,
          excluded_commands: ["skills", "auth", "publish"],
        },
        null,
        2,
      ),
    );
    return ExitCode.success;
  }
  if (parsed.action === "describe") {
    const tool = findTool(parsed.tool_name);
    if (tool === undefined) {
      throw new PaperbotError(
        `unknown tool: ${parsed.tool_name}; expected one of: ${toolCatalog.map(({ name }) => name).join(", ")}`,
        ExitCode.usage,
      );
    }
    io.stdout(
      JSON.stringify(
        {
          schema_version: TOOL_SCHEMA_VERSION,
          tool,
        },
        null,
        2,
      ),
    );
    return ExitCode.success;
  }

  if (parsed.action === "repo_scan") {
    const result = await runRepositoryScan({
      repository_path: parsed.repository_path,
      exclusions: parsed.exclusions,
      inclusions: parsed.inclusions,
    });
    return writeScanResult(io, parsed.format, result);
  }

  if (parsed.action === "paper_scaffold") {
    const result = await runPaperScaffold({
      scan_path: parsed.scan_path,
      ...(parsed.title === undefined ? {} : { title: parsed.title }),
    });
    return writeToolScaffoldResult(io, parsed.format, result);
  }

  const result = await runPaperValidation({
    input_path: parsed.input_path,
    profile: parsed.profile,
  });
  return writeValidationResult(io, parsed.format, result);
}

function writeScanResult(
  io: CliIo,
  format: "text" | "json",
  result: ScanResult,
): number {
  if (format === "json") {
    io.stdout(JSON.stringify(result.manifest, null, 2));
    io.stderr(
      `paperbot: selected ${result.manifest.files.length} files from ${result.discovered_file_count} discovered files`,
    );
  } else {
    io.stdout(formatScanResult(result));
  }
  return ExitCode.success;
}

function writeValidationResult(
  io: CliIo,
  format: "text" | "json",
  result: PaperValidationResult,
): number {
  if (format === "json") {
    io.stdout(JSON.stringify(result.report, null, 2));
    io.stderr(
      `paperbot: validation ${result.report.valid ? "passed" : "failed"} with ${result.report.diagnostics.length} diagnostics`,
    );
  } else {
    io.stdout(formatValidationResult(result));
  }
  return result.report.valid ? ExitCode.success : ExitCode.validation;
}

function writeToolScaffoldResult(
  io: CliIo,
  format: "text" | "json",
  result: DraftPreparation,
): number {
  if (format === "json") {
    io.stdout(
      JSON.stringify(
        {
          schema_version: result.report.schema_version,
          valid: result.report.valid,
          diagnostics: result.report.diagnostics,
          ...(result.markdown === undefined
            ? {}
            : { markdown: result.markdown }),
        },
        null,
        2,
      ),
    );
  } else if (result.report.valid && result.markdown !== undefined) {
    io.stdout(result.markdown);
    io.stderr("paperbot: created draft scaffold on stdout");
  } else {
    writeDraftDiagnostics(io, result);
  }

  return result.report.valid && result.markdown !== undefined
    ? ExitCode.success
    : ExitCode.validation;
}

function writeDraftDiagnostics(io: CliIo, result: DraftPreparation): void {
  for (const diagnostic of result.report.diagnostics) {
    io.stderr(
      `paperbot: [${diagnostic.severity}] ${diagnostic.code} ${diagnostic.path}: ${diagnostic.message}`,
    );
  }
}

async function loadAgentBatch(): Promise<typeof import("./agent/batch.ts")> {
  return import("./agent/batch.ts");
}

function writeAgentResult(
  io: CliIo,
  format: "text" | "json",
  action: "run" | "resume",
  result: AgentRunResult,
): void {
  if (format === "json") {
    io.stdout(JSON.stringify(result, null, 2));
    io.stderr(
      `paperbot: agent ${action} completed with ${result.validation.diagnostics} validation diagnostics`,
    );
    return;
  }

  io.stdout(
    [
      action === "run"
        ? "Paperbot agent draft prepared"
        : "Paperbot agent revision proposal prepared",
      `Run: ${result.run_path}`,
      `State: ${result.state}`,
      `Validation: ${result.validation.valid ? "passed" : "needs author attention"} (${result.validation.diagnostics} diagnostics)`,
      `Source revision: ${result.source.resolved_revision}`,
      `Selected files: ${result.source.selected_file_count}`,
      "Publication: not attempted. Review the draft, evidence, and author questions before any submission.",
    ].join("\n"),
  );
}

function writeAgentBatchResult(
  io: CliIo,
  format: "text" | "json",
  result: AgentBatchResult,
): void {
  if (format === "json") {
    io.stdout(JSON.stringify(result, null, 2));
    io.stderr(
      `paperbot: agent batch completed with ${result.report.summary.succeeded} succeeded and ${result.report.summary.failed} failed projects`,
    );
    return;
  }

  io.stdout(
    [
      "Paperbot agent batch completed",
      `Runs: ${result.output_path}`,
      `Projects: ${result.report.summary.total}`,
      `Succeeded: ${result.report.summary.succeeded}`,
      `Failed: ${result.report.summary.failed}`,
      `Report: ${result.output_path}/batch.json`,
      "Publication: not attempted. Review every private draft, evidence ledger, question list, and validation report before any submission.",
    ].join("\n"),
  );
}

async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new PaperbotError(
      "interactive token entry requires a TTY; use --token-stdin",
      ExitCode.usage,
    );
  }
  process.stderr.write(prompt);
  const mutedOutput = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const readline = createInterface({
    input: process.stdin,
    output: mutedOutput,
    terminal: true,
  });
  try {
    return await readline.question("");
  } finally {
    readline.close();
    process.stderr.write("\n");
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function confirm(prompt: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    throw new PaperbotError(
      "non-interactive publication requires --yes",
      ExitCode.usage,
    );
  }
  const readline = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    const answer = (await readline.question(prompt)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    readline.close();
  }
}

if (import.meta.main) {
  process.exitCode = await run(Bun.argv.slice(2));
}
