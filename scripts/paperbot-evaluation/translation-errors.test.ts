import { expect, test } from "bun:test";
import { ProdxivApiError } from "../../packages/api-client/src/client.ts";
import { translationDiagnostic } from "./translation-errors.ts";
import { parseTranslation } from "./translation-model.ts";

test("diagnostics never echo arbitrary API, model, network, or JSON error text", () => {
  const secret = "private-bearer-token-and-model-output";
  for (const error of [
    new Error(secret),
    new ProdxivApiError(401, "auth.unauthorized", secret),
    new ProdxivApiError(0, "network.request_failed", secret),
    new ProdxivApiError(422, "translation.invalid", secret),
    new ProdxivApiError(500, secret, secret),
  ]) {
    expect(
      JSON.stringify(translationDiagnostic(error, "translate")),
    ).not.toContain(secret);
  }
  try {
    parseTranslation(`not JSON: ${secret}`);
    throw new Error("expected invalid JSON");
  } catch (error) {
    const diagnostic = translationDiagnostic(error, "translate");
    expect(diagnostic.code).toBe("translation.invalid_json");
    expect(JSON.stringify(diagnostic)).not.toContain(secret);
  }
});

test("diagnostics retain useful API status and fixed validation reasons", () => {
  expect(
    translationDiagnostic(
      new ProdxivApiError(
        422,
        "translation.invalid",
        "translation changed headings, links, code, or embedded HTML structure",
      ),
      "save_translation",
    ),
  ).toEqual({
    stage: "save_translation",
    code: "translation.invalid",
    http_status: 422,
    message:
      "translation changed headings, links, code, or embedded HTML structure",
  });
  expect(
    translationDiagnostic(
      new ProdxivApiError(503, "unrecognized.code", "private response"),
      "load_jobs",
    ),
  ).toMatchObject({
    code: "api.request_failed",
    http_status: 503,
    stage: "load_jobs",
  });
});
