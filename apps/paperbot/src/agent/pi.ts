import { chmod, lstat, mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

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
  AuthoringRuntime,
  AuthoringSession,
  ModelCompletion,
  ModelSessionSnapshot,
  PiSessionRole,
} from "./types.ts";

const DEEPSEEK_PROVIDER = "deepseek";
const DEFAULT_MODEL = "deepseek-v4-flash";
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export type { PiSessionRole } from "./types.ts";

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
  session_directory: string;
  session_path?: string;
  system_prompt?: string;
}

export type PersistentPiSession = AgentSession & { sessionFile: string };

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
): Promise<PersistentPiSession> {
  const sessionDirectory = resolvePrivateSessionDirectory(
    options.run_path,
    options.session_directory,
  );
  await secureSessionDirectory(sessionDirectory);
  const sessionPath =
    options.session_path === undefined
      ? undefined
      : resolveSessionPath(options.session_path, sessionDirectory);
  if (sessionPath !== undefined) {
    await secureSessionArtifact(sessionPath);
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
    sessionPath === undefined
      ? await createPersistentSessionManager(options.run_path, sessionDirectory)
      : SessionManager.open(sessionPath, sessionDirectory, options.run_path);
  if (!sessionManager.isPersisted()) {
    throw new PaperbotError("Pi session persistence is disabled", ExitCode.io);
  }
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
  if (
    session.sessionFile === undefined ||
    !session.sessionFile.endsWith(".jsonl") ||
    dirname(resolve(session.sessionFile)) !== sessionDirectory
  ) {
    session.dispose();
    throw new PaperbotError(
      "Pi did not allocate a persistent JSONL session artifact",
      ExitCode.io,
    );
  }
  await secureSessionArtifact(session.sessionFile);
  return session as PersistentPiSession;
}

class PiConversation implements AuthoringSession {
  constructor(
    private readonly session: PersistentPiSession,
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
        provider: final.provider,
        model: final.model,
        ...(final.responseModel === undefined
          ? {}
          : { response_model: final.responseModel }),
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
      session_path: this.session.sessionFile,
    };
  }

  dispose(): void {
    this.session.dispose();
  }
}

async function secureSessionArtifact(path: string): Promise<void> {
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

function resolvePrivateSessionDirectory(
  runPath: string,
  sessionDirectory: string,
): string {
  const run = resolve(runPath);
  const directory = resolve(sessionDirectory);
  const relativeDirectory = relative(run, directory);
  const directoryParts = relativeDirectory.split(sep);
  if (
    relativeDirectory.length === 0 ||
    relativeDirectory === ".." ||
    relativeDirectory.startsWith(`..${sep}`) ||
    isAbsolute(relativeDirectory) ||
    directoryParts.length !== 2 ||
    directoryParts[0] !== "sessions" ||
    directoryParts[1]?.length === 0
  ) {
    throw new PaperbotError(
      "Pi session directory is outside its Paperbot run directory",
      ExitCode.io,
    );
  }
  return directory;
}

function resolveSessionPath(
  sessionPath: string,
  sessionDirectory: string,
): string {
  if (!isAbsolute(sessionPath)) {
    throw new PaperbotError(
      "Pi session artifact path must be absolute",
      ExitCode.io,
    );
  }
  const path = resolve(sessionPath);
  if (dirname(path) !== sessionDirectory || !path.endsWith(".jsonl")) {
    throw new PaperbotError(
      "Pi session artifact is outside its Paperbot session directory",
      ExitCode.io,
    );
  }
  return path;
}

async function secureSessionDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    const [sessionsMetadata, metadata] = await Promise.all([
      lstat(dirname(path)),
      lstat(path),
    ]);
    if (
      !sessionsMetadata.isDirectory() ||
      sessionsMetadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      metadata.isSymbolicLink()
    ) {
      throw new Error("unsafe session directory");
    }
    await Promise.all([
      chmod(dirname(path), PRIVATE_DIRECTORY_MODE),
      chmod(path, PRIVATE_DIRECTORY_MODE),
    ]);
  } catch {
    throw new PaperbotError(
      "Paperbot could not secure the Pi session directory",
      ExitCode.io,
    );
  }
}

async function createPersistentSessionManager(
  runPath: string,
  sessionDirectory: string,
): Promise<SessionManager> {
  // Pi normally defers a new file until the first assistant message. Persist
  // Pi's own header and reopen it so the initial user turn also survives a
  // provider failure before any assistant response arrives.
  const provisional = SessionManager.create(runPath, sessionDirectory);
  const sessionPath = provisional.getSessionFile();
  if (sessionPath === undefined) {
    throw new PaperbotError(
      "Pi did not allocate a session artifact",
      ExitCode.io,
    );
  }
  try {
    await writeFile(
      sessionPath,
      `${JSON.stringify(provisional.getHeader())}\n`,
      { flag: "wx", mode: PRIVATE_FILE_MODE },
    );
  } catch {
    throw new PaperbotError(
      "Paperbot could not initialize the Pi session artifact",
      ExitCode.io,
    );
  }
  await secureSessionArtifact(sessionPath);
  return SessionManager.open(sessionPath, sessionDirectory, runPath);
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
