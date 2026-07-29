#!/usr/bin/env bun

import { parseArguments } from "./arguments.ts";
import {
  defaultAuthPath,
  initializeAuth,
  removeAuth,
  resolveAuth,
  saveAuth,
} from "./auth.ts";
import { preparePaperDraft, writePaperDraft } from "./drafter.ts";
import { ExitCode, PaperbotError } from "./errors.ts";
import { formatScanResult, formatValidationResult } from "./output.ts";
import { preparePublication } from "./publisher.ts";
import { scanRepository } from "./scanner.ts";
import { validatePaperFile } from "./validator.ts";
import { ProdxivApiError } from "@prodxiv/api-client";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

const VERSION = "0.0.1";

const HELP = `Paperbot — repository-assisted product paper drafting

Usage:
  paperbot scan [repository] [--format text|json] [--exclude <glob>] [--include <glob>]
  paperbot draft <scan.json> [--title <title>] [--output <paper.md>]
  paperbot validate <paper.md> [--profile draft|submission|publication] [--format text|json]
  paperbot auth [init]
  paperbot auth set --api-url <url> [--site-url <url>] [--token-stdin]
  paperbot auth status
  paperbot auth remove
  paperbot publish <paper.md> [--product-id <id>] [--format text|json] [--yes]
  paperbot --help
  paperbot --version

Commands:
  scan      Select relevant repository files into a private scan manifest
  draft     Create a Markdown paper scaffold from a scan manifest
  validate  Validate a product paper
  auth      Configure local publishing authentication
  publish   Validate and explicitly publish a product paper

Options:
  --format <format>    Output format: text (default) or json
  --exclude <glob>     Exclude an additional repository-relative glob; repeatable
  --include <glob>     Override a default path exclusion; repeatable
  --output <path>      Write a new draft without overwriting existing work
  --title <title>      Set the initial draft title
  --profile <profile>  Validation profile: draft (default), submission, or publication
  --api-url <url>      Publishing API base URL
  --site-url <url>     Public website base URL for reader links
  --token-stdin        Read the publishing token from stdin
  --product-id <id>    Attach a new paper to an existing product
  --yes                Confirm publication without an interactive prompt
  -h, --help           Show help
  -V, --version        Show version
`;

export interface CliIo {
  stdout: (message: string) => void;
  stderr: (message: string) => void;
  read_secret?: (prompt: string) => Promise<string>;
  read_stdin?: () => Promise<string>;
  confirm?: (prompt: string) => Promise<boolean>;
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
