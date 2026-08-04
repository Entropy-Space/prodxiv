import { chmod, lstat, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  type AgentSession,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  InMemoryCredentialStore,
  type AssistantMessage,
  type TextContent,
} from "@earendil-works/pi-ai";

import { ExitCode, PaperbotError } from "@prodxiv/paperbot-core";
import { artifactPath } from "./artifacts.ts";
import {
  normalizeLoopbackBaseUrl,
  redactModelSecrets,
  resolvePiConnection,
} from "./model-config.ts";
import { PAPERBOT_SYSTEM_PROMPT } from "./prompts.ts";
import type {
  AgentSessionRole,
  AuthoringRuntime,
  AuthoringSession,
  ModelCompletion,
  ModelSessionSnapshot,
} from "./types.ts";

const DEEPSEEK_PROVIDER = "deepseek";
const DEFAULT_MODEL = "deepseek-v4-flash";
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export type PiSessionRole = AgentSessionRole | "trend_selection";

export interface PiAgentRuntimeOptions {
  model?: string;
  api_key?: string;
  base_url?: string;
  system_prompt?: string;
}

export type PiAuthoringRuntimeOptions = PiAgentRuntimeOptions;

export interface IsolatedPiSessionOptions {
  api_key: string;
  base_url?: string;
  model: string;
  run_path: string;
  session_directory?: string;
  session_path?: string;
  system_prompt?: string;
}

/**
 * Pi SDK adapter deliberately runs without Pi's built-in tools, local
 * credentials, extensions, skills, or context-file discovery. Paperbot creates
 * private logical sessions inside the run directory. Paper drafting uses one
 * evidence session and one resumable author session; other bounded workflows
 * may supply their own isolated system prompt and role.
 */
export class PiAgentRuntime implements AuthoringRuntime {
  readonly provider = "pi";
  readonly model: string;
  private readonly apiKey?: string;
  private readonly baseUrl?: string;
  private readonly systemPrompt?: string;

  constructor(options: PiAgentRuntimeOptions = {}) {
    this.model = options.model ?? DEFAULT_MODEL;
    this.apiKey = options.api_key;
    this.baseUrl = options.base_url;
    this.systemPrompt = options.system_prompt;
  }

  async startSession(input: {
    role: PiSessionRole;
    run_path: string;
    session_id?: string;
    session_path?: string;
  }): Promise<AuthoringSession> {
    const connection = resolvePiConnection({
      ...(this.apiKey === undefined ? {} : { api_key: this.apiKey }),
      ...(this.baseUrl === undefined ? {} : { base_url: this.baseUrl }),
    });
    try {
      const sessionDirectory = artifactPath(
        input.run_path,
        `sessions/${input.role}`,
      );
      await mkdir(sessionDirectory, {
        recursive: true,
        mode: PRIVATE_DIRECTORY_MODE,
      });
      await chmod(sessionDirectory, PRIVATE_DIRECTORY_MODE);
      const session = await createIsolatedPiSession({
        api_key: connection.api_key,
        ...(connection.base_url === undefined
          ? {}
          : { base_url: connection.base_url }),
        model: this.model,
        run_path: input.run_path,
        session_directory: sessionDirectory,
        ...(this.systemPrompt === undefined
          ? {}
          : { system_prompt: this.systemPrompt }),
        ...(input.session_path === undefined
          ? {}
          : { session_path: input.session_path }),
      });
      if (
        input.session_id !== undefined &&
        session.sessionId !== input.session_id
      ) {
        session.dispose();
        throw new PaperbotError(
          "Pi session ID does not match the Paperbot run record",
          ExitCode.io,
        );
      }
      return new PiConversation(session, connection.api_key);
    } catch (error) {
      throw piError(error, connection.api_key);
    }
  }
}

export { PiAgentRuntime as PiAuthoringRuntime };

export async function createIsolatedPiSession(
  options: IsolatedPiSessionOptions,
): Promise<AgentSession> {
  if (
    options.session_directory !== undefined &&
    options.session_path !== undefined &&
    dirname(resolve(options.session_path)) !==
      resolve(options.session_directory)
  ) {
    throw new PaperbotError(
      "Pi session artifact is outside its Paperbot session directory",
      ExitCode.io,
    );
  }
  if (options.session_path !== undefined) {
    try {
      const metadata = await lstat(options.session_path);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error("unsafe session artifact");
      }
    } catch {
      throw new PaperbotError(
        "Pi session artifact is not a safe regular file",
        ExitCode.io,
      );
    }
  }
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
  });
  if (options.base_url !== undefined) {
    runtime.registerProvider(DEEPSEEK_PROVIDER, {
      baseUrl: normalizeLoopbackBaseUrl(options.base_url),
    });
  }
  await runtime.setRuntimeApiKey(DEEPSEEK_PROVIDER, options.api_key, {
    allowNetwork: false,
  });
  const model = runtime.getModel(DEEPSEEK_PROVIDER, options.model);
  if (model === undefined) {
    throw new PaperbotError(
      `Pi does not provide the requested DeepSeek model: ${options.model}`,
      ExitCode.auth,
    );
  }

  const loader = new DefaultResourceLoader({
    cwd: options.run_path,
    agentDir: options.run_path,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: options.system_prompt ?? PAPERBOT_SYSTEM_PROMPT,
  });
  await loader.reload();
  const sessionManager =
    options.session_path !== undefined
      ? SessionManager.open(
          options.session_path,
          options.session_directory,
          options.run_path,
        )
      : options.session_directory !== undefined
        ? SessionManager.create(options.run_path, options.session_directory)
        : SessionManager.inMemory(options.run_path);
  const { session } = await createAgentSession({
    cwd: options.run_path,
    modelRuntime: runtime,
    model,
    thinkingLevel: "high",
    noTools: "all",
    resourceLoader: loader,
    settingsManager: settings,
    sessionManager,
  });
  if (session.getActiveToolNames().length !== 0) {
    session.dispose();
    throw new PaperbotError(
      "Pi agent session unexpectedly exposed tools",
      ExitCode.auth,
    );
  }
  return session;
}

class PiConversation implements AuthoringSession {
  constructor(
    private readonly session: AgentSession,
    private readonly apiKey: string,
  ) {}

  async complete(input: { prompt: string }): Promise<ModelCompletion> {
    const previousMessageCount = this.session.messages.length;
    let finalAssistant: AssistantMessage | undefined;
    const unsubscribe = this.session.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "assistant") {
        finalAssistant = event.message;
      }
    });
    try {
      await this.session.prompt(input.prompt, { expandPromptTemplates: false });
      const final =
        finalAssistant ??
        lastAssistantMessage(this.session.messages.slice(previousMessageCount));
      if (final === undefined) {
        throw new PaperbotError(
          "Pi returned no assistant message",
          ExitCode.remote,
        );
      }
      if (final.stopReason === "error" || final.stopReason === "aborted") {
        throw new PaperbotError(
          final.errorMessage ?? `Pi stopped: ${final.stopReason}`,
          ExitCode.remote,
        );
      }
      await secureSessionArtifact(this.session.sessionFile);
      return {
        final_text: assistantText(final),
        model: final.model,
        usage: {
          input_tokens: final.usage.input,
          output_tokens: final.usage.output,
        },
      };
    } catch (error) {
      await secureSessionArtifact(this.session.sessionFile);
      throw piError(error, this.apiKey);
    } finally {
      unsubscribe();
    }
  }

  snapshot(): ModelSessionSnapshot {
    return {
      session_id: this.session.sessionId,
      ...(this.session.sessionFile === undefined
        ? {}
        : { session_path: this.session.sessionFile }),
    };
  }

  dispose(): void {
    this.session.dispose();
  }
}

async function secureSessionArtifact(path: string | undefined): Promise<void> {
  if (path === undefined) {
    return;
  }
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("unsafe session artifact");
    }
    await chmod(path, PRIVATE_FILE_MODE);
  } catch {
    throw new PaperbotError(
      "Paperbot could not secure the Pi session artifact",
      ExitCode.io,
    );
  }
}

function lastAssistantMessage(
  messages: readonly unknown[],
): AssistantMessage | undefined {
  for (const message of [...messages].reverse()) {
    if (isAssistantMessage(message)) {
      return message;
    }
  }
  return undefined;
}

function isAssistantMessage(value: unknown): value is AssistantMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "role" in value &&
    value.role === "assistant" &&
    "content" in value &&
    Array.isArray(value.content)
  );
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function piError(error: unknown, apiKey: string): PaperbotError {
  if (error instanceof PaperbotError) {
    return error;
  }
  const message = redactApiKey(
    error instanceof Error ? error.message : String(error),
    apiKey,
  );
  return new PaperbotError(`Pi agent failed: ${message}`, ExitCode.remote);
}

function redactApiKey(message: string, apiKey: string): string {
  return redactModelSecrets(message, [apiKey]);
}
