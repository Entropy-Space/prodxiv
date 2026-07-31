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

import { ExitCode, PaperbotError } from "../errors.ts";
import {
  normalizeLoopbackBaseUrl,
  redactModelSecrets,
  resolvePiConnection,
} from "./model-config.ts";
import { PAPERBOT_SYSTEM_PROMPT } from "./prompts.ts";
import type { AuthoringRuntime, ModelCompletion } from "./types.ts";

const DEEPSEEK_PROVIDER = "deepseek";
const DEFAULT_MODEL = "deepseek-v4-flash";

export interface PiAuthoringRuntimeOptions {
  model?: string;
  api_key?: string;
  base_url?: string;
}

export interface IsolatedPiSessionOptions {
  api_key: string;
  base_url?: string;
  model: string;
  run_path: string;
}

/**
 * Pi SDK adapter deliberately runs without Pi's built-in tools, local
 * credentials, sessions, extensions, skills, or context-file discovery.
 * The Paperbot runner supplies the bounded source bundle as prompt data.
 */
export class PiAuthoringRuntime implements AuthoringRuntime {
  readonly provider = "pi";
  readonly model: string;
  private readonly apiKey?: string;
  private readonly baseUrl?: string;

  constructor(options: PiAuthoringRuntimeOptions = {}) {
    this.model = options.model ?? DEFAULT_MODEL;
    this.apiKey = options.api_key;
    this.baseUrl = options.base_url;
  }

  async complete(input: {
    prompt: string;
    run_path: string;
  }): Promise<ModelCompletion> {
    const connection = resolvePiConnection({
      ...(this.apiKey === undefined ? {} : { api_key: this.apiKey }),
      ...(this.baseUrl === undefined ? {} : { base_url: this.baseUrl }),
    });

    try {
      const session = await createIsolatedPiSession({
        api_key: connection.api_key,
        ...(connection.base_url === undefined
          ? {}
          : { base_url: connection.base_url }),
        model: this.model,
        run_path: input.run_path,
      });

      let finalAssistant: AssistantMessage | undefined;
      const unsubscribe = session.subscribe((event) => {
        if (
          event.type === "message_end" &&
          event.message.role === "assistant"
        ) {
          finalAssistant = event.message;
        }
      });
      try {
        await session.prompt(input.prompt, { expandPromptTemplates: false });
        const final = finalAssistant ?? lastAssistantMessage(session.messages);
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
        return {
          final_text: assistantText(final),
          model: final.model,
          usage: {
            input_tokens: final.usage.input,
            output_tokens: final.usage.output,
          },
        };
      } finally {
        unsubscribe();
        session.dispose();
      }
    } catch (error) {
      if (error instanceof PaperbotError) {
        throw error;
      }
      const message = redactApiKey(
        error instanceof Error ? error.message : String(error),
        connection.api_key,
      );
      throw new PaperbotError(`Pi agent failed: ${message}`, ExitCode.remote);
    }
  }
}

export async function createIsolatedPiSession(
  options: IsolatedPiSessionOptions,
): Promise<AgentSession> {
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
    systemPrompt: PAPERBOT_SYSTEM_PROMPT,
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: options.run_path,
    modelRuntime: runtime,
    model,
    thinkingLevel: "high",
    noTools: "all",
    resourceLoader: loader,
    settingsManager: settings,
    sessionManager: SessionManager.inMemory(options.run_path),
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

function redactApiKey(message: string, apiKey: string): string {
  return redactModelSecrets(message, [apiKey]);
}
