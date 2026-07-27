#!/usr/bin/env bun

import { parseArguments } from "./arguments.ts";
import { preparePaperDraft, writePaperDraft } from "./drafter.ts";
import { ExitCode, PaperbotError } from "./errors.ts";
import { formatScanResult, formatValidationResult } from "./output.ts";
import { scanRepository } from "./scanner.ts";
import { validatePaperFile } from "./validator.ts";

const VERSION = "0.0.1";

const HELP = `Paperbot — repository-assisted product paper drafting

Usage:
  paperbot scan [repository] [--format text|json] [--exclude <glob>] [--include <glob>]
  paperbot draft <scan.json> [--title <title>] [--output <paper.md>]
  paperbot validate <paper.md> [--profile draft|publication] [--format text|json]
  paperbot --help
  paperbot --version

Commands:
  scan      Select relevant repository files into a private scan manifest
  draft     Create a Markdown paper scaffold from a scan manifest
  validate  Validate a product paper

Options:
  --format <format>    Output format: text (default) or json
  --exclude <glob>     Exclude an additional repository-relative glob; repeatable
  --include <glob>     Override a default path exclusion; repeatable
  --output <path>      Write a new draft without overwriting existing work
  --title <title>      Set the initial draft title
  --profile <profile>  Validation profile: draft (default) or publication
  -h, --help           Show help
  -V, --version        Show version
`;

export interface CliIo {
  stdout: (message: string) => void;
  stderr: (message: string) => void;
}

const defaultIo: CliIo = {
  stdout: (message) => console.log(message),
  stderr: (message) => console.error(message),
};

export async function run(
  args: string[],
  io: CliIo = defaultIo,
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

    if (parsed.command === "validate") {
      const result = await validatePaperFile(parsed.input_path, parsed.profile);
      if (parsed.format === "json") {
        io.stdout(JSON.stringify(result.report, null, 2));
        io.stderr(
          `paperbot: validation ${result.report.valid ? "passed" : "failed"} with ${result.report.diagnostics.length} diagnostics`,
        );
      } else {
        io.stdout(formatValidationResult(result));
      }
      return result.report.valid ? ExitCode.success : ExitCode.validation;
    }

    if (parsed.command === "draft") {
      const result = await preparePaperDraft(parsed.scan_path, {
        ...(parsed.output_path === undefined
          ? {}
          : { output_path: parsed.output_path }),
        ...(parsed.title === undefined ? {} : { title: parsed.title }),
      });
      if (!result.report.valid || result.markdown === undefined) {
        for (const diagnostic of result.report.diagnostics) {
          io.stderr(
            `paperbot: [${diagnostic.severity}] ${diagnostic.code} ${diagnostic.path}: ${diagnostic.message}`,
          );
        }
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

    const result = await scanRepository(parsed.repository_path, {
      exclusions: parsed.exclusions,
      inclusions: parsed.inclusions,
    });
    if (parsed.format === "json") {
      io.stdout(JSON.stringify(result.manifest, null, 2));
      io.stderr(
        `paperbot: selected ${result.manifest.files.length} files from ${result.discovered_file_count} discovered files`,
      );
    } else {
      io.stdout(formatScanResult(result));
    }
    return ExitCode.success;
  } catch (error) {
    if (error instanceof PaperbotError) {
      io.stderr(`paperbot: ${error.message}`);
      return error.exit_code;
    }
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`paperbot: unexpected failure: ${message}`);
    return ExitCode.scan;
  }
}

if (import.meta.main) {
  process.exitCode = await run(Bun.argv.slice(2));
}
