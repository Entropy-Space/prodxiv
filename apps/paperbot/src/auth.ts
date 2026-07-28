import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { ExitCode, PaperbotError } from "./errors.ts";

export interface AuthConfig {
  version: 1;
  api_url: string;
  site_url?: string;
  token: string;
}

export interface ResolvedAuth extends AuthConfig {
  source: "environment" | "file" | "mixed";
}

export interface AuthResolutionOptions {
  auth_path?: string;
  env?: Record<string, string | undefined>;
}

export function defaultAuthPath(): string {
  return join(homedir(), ".tokn", "prodxiv", "auth.toml");
}

export async function initializeAuth(
  authPath = defaultAuthPath(),
): Promise<boolean> {
  return createAuthTemplate(authPath);
}

export async function saveAuth(
  apiUrl: string,
  token: string,
  authPath = defaultAuthPath(),
  siteUrl?: string,
): Promise<AuthConfig> {
  const config: AuthConfig = {
    version: 1,
    api_url: normalizeBaseUrl(apiUrl, "API"),
    ...(siteUrl === undefined
      ? {}
      : { site_url: normalizeBaseUrl(siteUrl, "site") }),
    token: validateToken(token),
  };
  const directory = dirname(authPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);

  const temporaryPath = join(
    directory,
    `.${basename(authPath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  const contents = formatAuthFile(config);
  try {
    await writeFile(temporaryPath, contents, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, authPath);
    await chmod(authPath, 0o600);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    throw new PaperbotError(
      `could not save authentication: ${message}`,
      ExitCode.auth,
    );
  }
  return config;
}

export async function resolveAuth(
  options: AuthResolutionOptions = {},
): Promise<ResolvedAuth> {
  const env = options.env ?? process.env;
  const authPath = options.auth_path ?? defaultAuthPath();
  const envApiUrl = env.PRODXIV_API_URL?.trim();
  const envSiteUrl = env.PRODXIV_SITE_URL?.trim();
  const envToken = env.PRODXIV_PUBLISH_TOKEN?.trim();
  let fileConfig: AuthConfig | undefined;

  if (envApiUrl === undefined || envToken === undefined) {
    fileConfig = await readAuthFile(authPath);
  }
  const apiUrl = envApiUrl ?? fileConfig?.api_url;
  const siteUrl = envSiteUrl ?? fileConfig?.site_url;
  const token = envToken ?? fileConfig?.token;
  if (apiUrl === undefined || token === undefined) {
    throw new PaperbotError(
      `authentication is not configured; run paperbot auth set --api-url <url> or set PRODXIV_API_URL and PRODXIV_PUBLISH_TOKEN`,
      ExitCode.auth,
    );
  }

  return {
    version: 1,
    api_url: normalizeBaseUrl(apiUrl, "API"),
    ...(siteUrl === undefined
      ? {}
      : { site_url: normalizeBaseUrl(siteUrl, "site") }),
    token: validateToken(token),
    source:
      envApiUrl !== undefined && envToken !== undefined
        ? "environment"
        : envApiUrl === undefined && envToken === undefined
          ? "file"
          : "mixed",
  };
}

export async function removeAuth(
  authPath = defaultAuthPath(),
): Promise<boolean> {
  try {
    await rm(authPath);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new PaperbotError(
      `could not remove authentication: ${message}`,
      ExitCode.auth,
    );
  }
}

async function createAuthTemplate(authPath: string): Promise<boolean> {
  const directory = dirname(authPath);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    await writeFile(authPath, formatAuthFile(), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await chmod(authPath, 0o600);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      return false;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new PaperbotError(
      `could not create authentication template: ${message}`,
      ExitCode.auth,
    );
  }
}

async function readAuthFile(authPath: string): Promise<AuthConfig | undefined> {
  let stats;
  try {
    stats = await lstat(authPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw authReadError(authPath, error);
  }
  if (!stats.isFile()) {
    throw new PaperbotError(
      `authentication path is not a regular file: ${authPath}`,
      ExitCode.auth,
    );
  }
  if ((stats.mode & 0o077) !== 0) {
    throw new PaperbotError(
      `authentication file permissions are too broad: ${authPath}; run chmod 600 ${authPath}`,
      ExitCode.auth,
    );
  }

  try {
    const parsed = Bun.TOML.parse(await readFile(authPath, "utf8")) as unknown;
    if (!isRecord(parsed) || parsed.version !== 1) {
      throw new Error("version must be 1");
    }
    if (
      typeof parsed.api_url !== "string" ||
      typeof parsed.token !== "string" ||
      !(parsed.site_url === undefined || typeof parsed.site_url === "string")
    ) {
      throw new PaperbotError(
        `authentication template is incomplete: ${authPath}; fill in api_url and token`,
        ExitCode.auth,
      );
    }
    return {
      version: 1,
      api_url: normalizeBaseUrl(parsed.api_url, "API"),
      ...(parsed.site_url === undefined
        ? {}
        : { site_url: normalizeBaseUrl(parsed.site_url, "site") }),
      token: validateToken(parsed.token),
    };
  } catch (error) {
    if (error instanceof PaperbotError) {
      throw error;
    }
    throw authReadError(authPath, error);
  }
}

function formatAuthFile(config?: AuthConfig): string {
  return [
    "# Paperbot publishing credentials.",
    "# This file contains a secret. Keep its permissions set to 0600.",
    "version = 1",
    "",
    "# Base URL of the prodxiv publishing API.",
    config === undefined
      ? '# api_url = "https://your-prodxiv-api.example"'
      : `api_url = ${JSON.stringify(config.api_url)}`,
    "",
    "# Public prodxiv website used to link successful publications.",
    config?.site_url === undefined
      ? '# site_url = "https://your-prodxiv-site.example"'
      : `site_url = ${JSON.stringify(config.site_url)}`,
    "",
    "# Bearer token used only for explicit publication requests.",
    config === undefined
      ? '# token = "replace-with-your-publishing-token"'
      : `token = ${JSON.stringify(config.token)}`,
    "",
  ].join("\n");
}

function normalizeBaseUrl(value: string, label: "API" | "site"): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PaperbotError(`${label} URL is invalid: ${value}`, ExitCode.auth);
  }
  const isLocal =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1";
  if (url.protocol !== "https:" && !(isLocal && url.protocol === "http:")) {
    throw new PaperbotError(
      `${label} URL must use HTTPS, except for localhost`,
      ExitCode.auth,
    );
  }
  if (
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new PaperbotError(
      `${label} URL must not contain credentials, a query, or a fragment`,
      ExitCode.auth,
    );
  }
  return url.toString().replace(/\/+$/, "");
}

function validateToken(value: string): string {
  const token = value.trim();
  if (token.length < 32) {
    throw new PaperbotError(
      "publishing token must contain at least 32 characters",
      ExitCode.auth,
    );
  }
  return token;
}

function authReadError(path: string, error: unknown): PaperbotError {
  const message = error instanceof Error ? error.message : String(error);
  return new PaperbotError(
    `could not read authentication from ${path}: ${message}`,
    ExitCode.auth,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
