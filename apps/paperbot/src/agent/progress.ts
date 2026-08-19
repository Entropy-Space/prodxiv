import { ExitCode, PaperbotError } from "@prodxiv/paperbot-core";

import type { PiSessionRole } from "./types.ts";

export type AgentProgressOperation =
  | "acquire_source"
  | "batch_project"
  | "checkpoint"
  | "draft_correction"
  | "draft_review"
  | "evidence_analysis"
  | "evidence_correction"
  | "initial_draft"
  | "parse_response"
  | "revise_from_answers"
  | "run"
  | "trend_selection"
  | "validate_draft"
  | "validate_evidence"
  | "validate_selection";

export type AgentProgressEvent =
  | {
      kind: "conversation";
      session_role: PiSessionRole;
      message_role: "user" | "assistant";
      operation: AgentProgressOperation;
      status: "started" | "completed" | "failed";
      summary: string;
      turn_number?: number;
      duration_ms?: number;
      response_byte_count?: number;
      input_tokens?: number;
      output_tokens?: number;
    }
  | {
      kind: "host";
      operation: AgentProgressOperation;
      status: "started" | "completed" | "retrying" | "failed";
      summary: string;
      session_role?: PiSessionRole;
    };

export type AgentProgressReporter = (event: AgentProgressEvent) => void;

export interface AgentProgressContext {
  repository_label: string;
  project_index?: number;
  project_count?: number;
}

export function emitAgentProgress(
  reporter: AgentProgressReporter | undefined,
  event: AgentProgressEvent,
): void {
  try {
    reporter?.(event);
  } catch {
    // Progress is diagnostic only and must never change the run outcome.
  }
}

export function formatAgentProgress(
  event: AgentProgressEvent,
  context: AgentProgressContext,
): string {
  const projectPrefix =
    context.project_index === undefined || context.project_count === undefined
      ? `[${context.repository_label}]`
      : `[${context.project_index}/${context.project_count} ${context.repository_label}]`;
  const sessionPrefix =
    event.kind === "conversation" || event.session_role !== undefined
      ? ` [${event.session_role}]`
      : "";
  const actor =
    event.kind === "conversation"
      ? event.message_role
      : `host(${event.operation})`;
  const status = event.kind === "host" ? `${event.status} — ` : "";
  const metrics =
    event.kind === "conversation" ? conversationMetrics(event) : [];
  const suffix = metrics.length === 0 ? "" : ` (${metrics.join(", ")})`;
  return `paperbot: ${projectPrefix}${sessionPrefix} ${actor}: ${status}${singleLine(event.summary)}${suffix}`;
}

export function githubRepositoryLabel(repositoryUrl: string): string {
  try {
    const url = new URL(repositoryUrl);
    if (url.hostname.toLowerCase() !== "github.com") {
      return "remote";
    }
    const path = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
    return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(path) ? path : "remote";
  } catch {
    return "local";
  }
}

export function safeProgressSummary(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  return singleLine(message, 240);
}

export function summarizeAgentError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const httpStatus = extractHttpStatus(message);
  if (error instanceof PaperbotError) {
    if (error.exit_code === ExitCode.validation) {
      return "Deterministic validation failed";
    }
    if (error.exit_code === ExitCode.auth) {
      return "Model authentication failed";
    }
    if (error.exit_code === ExitCode.network) {
      return requestFailureSummary(
        "Network request failed",
        message,
        httpStatus,
      );
    }
    if (error.exit_code === ExitCode.remote) {
      return requestFailureSummary(
        "Remote request failed",
        message,
        httpStatus,
      );
    }
    if (error.exit_code === ExitCode.repository) {
      return "Repository acquisition failed";
    }
    if (error.exit_code === ExitCode.scan) {
      return "Repository or private artifact operation failed";
    }
    if (error.exit_code === ExitCode.usage) {
      return "Configuration validation failed";
    }
  }
  return "Unexpected agent failure";
}

function conversationMetrics(
  event: Extract<AgentProgressEvent, { kind: "conversation" }>,
): string[] {
  const metrics: string[] = [];
  if (event.duration_ms !== undefined) {
    metrics.push(formatDuration(event.duration_ms));
  }
  if (event.input_tokens !== undefined || event.output_tokens !== undefined) {
    metrics.push(
      `tokens=${event.input_tokens ?? "?"}/${event.output_tokens ?? "?"}`,
    );
  }
  if (event.response_byte_count !== undefined) {
    metrics.push(`response=${formatBytes(event.response_byte_count)}`);
  }
  return metrics;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) {
    return `${durationMs}ms`;
  }
  return `${(durationMs / 1_000).toFixed(1)}s`;
}

function formatBytes(byteCount: number): string {
  if (byteCount < 1_024) {
    return `${byteCount}B`;
  }
  return `${(byteCount / 1_024).toFixed(1)}KiB`;
}

function singleLine(value: string, maximumLength = 500): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= maximumLength) {
    return normalized;
  }
  return `${normalized.slice(0, maximumLength - 1)}…`;
}

function extractHttpStatus(message: string): string | undefined {
  return message.match(/\b(?:HTTP|status(?: code)?)\s*[:=]?\s*(\d{3})\b/i)?.[1];
}

function requestFailureSummary(
  fallback: string,
  message: string,
  httpStatus: string | undefined,
): string {
  const qualifier = /rate.?limit|too many requests/i.test(message)
    ? "rate limited"
    : /timed?\s*out|timeout/i.test(message)
      ? "timed out"
      : /content|response|payload|body/i.test(message) &&
          /limit|large|size|exceed/i.test(message)
        ? "response exceeded its size limit"
        : undefined;
  return [
    fallback,
    qualifier,
    httpStatus === undefined ? undefined : `HTTP ${httpStatus}`,
  ]
    .filter((value): value is string => value !== undefined)
    .join(" — ");
}
