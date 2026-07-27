#!/usr/bin/env bun

import { parseArguments } from "./arguments.ts";
import { ExitCode, PaperbotError } from "./errors.ts";
import { formatScanResult } from "./output.ts";
import { scanRepository } from "./scanner.ts";

const VERSION = "0.0.1";

const HELP = `Paperbot — evidence-backed product paper drafting

Usage:
  paperbot scan [repository] [--format text|json] [--exclude <glob>] [--include <glob>]
  paperbot --help
  paperbot --version

Commands:
  scan    Index relevant repository files into an evidence bundle

Options:
  --format <format>    Output format: text (default) or json
  --exclude <glob>     Exclude an additional repository-relative glob; repeatable
  --include <glob>     Override a default path exclusion; repeatable
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

    const result = await scanRepository(parsed.repository_path, {
      exclusions: parsed.exclusions,
      inclusions: parsed.inclusions,
    });
    if (parsed.format === "json") {
      io.stdout(JSON.stringify(result.bundle, null, 2));
      io.stderr(
        `paperbot: scanned ${result.bundle.sources.length} evidence sources from ${result.discovered_file_count} files`,
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
    io.stderr(`paperbot: unexpected scan failure: ${message}`);
    return ExitCode.scan;
  }
}

if (import.meta.main) {
  process.exitCode = await run(Bun.argv.slice(2));
}
