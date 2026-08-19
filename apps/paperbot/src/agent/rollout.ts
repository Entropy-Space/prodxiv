import { appendFile, chmod, readFile } from "node:fs/promises";

import { ExitCode, PaperbotError } from "@prodxiv/paperbot-core";
import { artifactPath, sha256 } from "./artifacts.ts";
import type { AgentProgressOperation } from "./progress.ts";
import type {
  AgentGitHubReleasePolicy,
  AgentObservedModel,
  AgentRunRecord,
  AgentSessionRole,
  ModelCompletion,
} from "./types.ts";

export const ROLLOUT_SCHEMA_VERSION = "1";
const MAX_ROLLOUT_BYTES = 2 * 1024 * 1024;

type RolloutEvent =
  | {
      kind: "run_started";
      github_release_policy: AgentGitHubReleasePolicy;
    }
  | {
      kind: "run_resumed";
    }
  | {
      kind: "github_releases_skipped";
      reason_code: string;
      message: string;
    }
  | {
      kind: "author_answers_recorded";
      round: number;
      feedback: "sync" | "async";
      answer_sha256: string;
      answer_byte_count: number;
    }
  | {
      kind: "assumptions_recorded";
      assumption_count: number;
      artifact_sha256: string;
    }
  | {
      kind: "model_turn_started";
      role: AgentSessionRole;
      operation: AgentProgressOperation;
      turn_number: number;
      prompt_sha256: string;
      prompt_byte_count: number;
    }
  | {
      kind: "model_turn_completed";
      role: AgentSessionRole;
      operation: AgentProgressOperation;
      turn_number: number;
      duration_ms: number;
      response_sha256: string;
      response_byte_count: number;
      provider: string;
      model: string;
      response_model?: string;
      input_tokens?: number;
      output_tokens?: number;
    }
  | {
      kind: "model_turn_failed";
      role: AgentSessionRole;
      operation: AgentProgressOperation;
      turn_number: number;
      duration_ms: number;
      error: string;
    }
  | {
      kind: "run_failed";
      error: string;
    }
  | {
      kind: "checkpoint_sealing";
      checkpoint_number: number;
      reason: string;
    };

export async function appendRolloutEvent(
  runPath: string,
  record: AgentRunRecord,
  occurredAt: string,
  event: RolloutEvent,
): Promise<void> {
  const eventNumber = record.rollout.event_count + 1;
  const artifact = artifactPath(runPath, record.artifacts.rollout);
  const value = {
    schema_version: ROLLOUT_SCHEMA_VERSION,
    event_id: `event:${eventNumber.toString().padStart(6, "0")}`,
    run_id: record.run_id,
    producer_build_id: record.producer.build_id,
    occurred_at: occurredAt,
    state: record.state,
    ...event,
    previous_event_sha256: record.rollout.last_event_sha256 ?? null,
  };
  const eventSha256 = sha256(JSON.stringify(value));
  const serializedEvent = `${JSON.stringify({
    ...value,
    event_sha256: eventSha256,
  })}\n`;
  try {
    const existing = await readOptionalRollout(artifact);
    if (sha256(existing) !== record.rollout.artifact_sha256) {
      throw new Error("rollout digest changed");
    }
    if (
      existing.byteLength + Buffer.byteLength(serializedEvent) >
      MAX_ROLLOUT_BYTES
    ) {
      throw new Error("rollout exceeds its byte limit");
    }
    await appendFile(artifact, serializedEvent, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(artifact, 0o600);
    record.rollout.artifact_sha256 = sha256(
      Buffer.concat([existing, Buffer.from(serializedEvent)]),
    );
    record.rollout.last_event_sha256 = eventSha256;
  } catch {
    throw new PaperbotError(
      `could not append agent rollout event: ${artifact}`,
      ExitCode.io,
    );
  }
  record.rollout.event_count = eventNumber;
}

export async function verifyRolloutArtifact(
  runPath: string,
  record: AgentRunRecord,
): Promise<void> {
  const path = artifactPath(runPath, record.artifacts.rollout);
  let serialized: Buffer;
  try {
    serialized = await readFile(path);
  } catch {
    throw invalidRollout(runPath);
  }
  if (
    serialized.byteLength > MAX_ROLLOUT_BYTES ||
    sha256(serialized) !== record.rollout.artifact_sha256
  ) {
    throw invalidRollout(runPath);
  }
  const lines = serialized
    .toString("utf8")
    .split("\n")
    .filter((line) => line.length > 0);
  let previous: string | null = null;
  for (const [index, line] of lines.entries()) {
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      throw invalidRollout(runPath);
    }
    if (
      !isRecord(value) ||
      value.schema_version !== ROLLOUT_SCHEMA_VERSION ||
      value.event_id !== `event:${(index + 1).toString().padStart(6, "0")}` ||
      value.run_id !== record.run_id ||
      value.previous_event_sha256 !== previous ||
      typeof value.event_sha256 !== "string"
    ) {
      throw invalidRollout(runPath);
    }
    const { event_sha256: eventSha256, ...event } = value;
    if (sha256(JSON.stringify(event)) !== eventSha256) {
      throw invalidRollout(runPath);
    }
    previous = eventSha256;
  }
  if (
    lines.length !== record.rollout.event_count ||
    previous !== (record.rollout.last_event_sha256 ?? null)
  ) {
    throw invalidRollout(runPath);
  }
}

export function modelTurnStartedEvent(
  role: AgentSessionRole,
  operation: AgentProgressOperation,
  turnNumber: number,
  prompt: string,
): RolloutEvent {
  return {
    kind: "model_turn_started",
    role,
    operation,
    turn_number: turnNumber,
    prompt_sha256: sha256(prompt),
    prompt_byte_count: Buffer.byteLength(prompt),
  };
}

export function modelTurnCompletedEvent(
  record: AgentRunRecord,
  role: AgentSessionRole,
  operation: AgentProgressOperation,
  turnNumber: number,
  durationMs: number,
  completion: ModelCompletion,
): RolloutEvent {
  const observation = modelObservation(completion);
  if (
    !record.rollout.observed_models.some(
      (item) => JSON.stringify(item) === JSON.stringify(observation),
    )
  ) {
    record.rollout.observed_models.push(observation);
  }
  record.rollout.total_input_tokens += completion.usage?.input_tokens ?? 0;
  record.rollout.total_output_tokens += completion.usage?.output_tokens ?? 0;
  return {
    kind: "model_turn_completed",
    role,
    operation,
    turn_number: turnNumber,
    duration_ms: durationMs,
    response_sha256: sha256(completion.final_text),
    response_byte_count: Buffer.byteLength(completion.final_text),
    provider: completion.provider,
    model: completion.model,
    ...(completion.response_model === undefined
      ? {}
      : { response_model: completion.response_model }),
    ...(completion.usage === undefined
      ? {}
      : {
          input_tokens: completion.usage.input_tokens,
          output_tokens: completion.usage.output_tokens,
        }),
  };
}

function modelObservation(completion: ModelCompletion): AgentObservedModel {
  return {
    provider: completion.provider,
    model: completion.model,
    ...(completion.response_model === undefined
      ? {}
      : { response_model: completion.response_model }),
  };
}

async function readOptionalRollout(path: string): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return Buffer.alloc(0);
    }
    throw error;
  }
}

function invalidRollout(runPath: string): PaperbotError {
  return new PaperbotError(
    `agent rollout artifact is invalid or was changed: ${runPath}`,
    ExitCode.io,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
