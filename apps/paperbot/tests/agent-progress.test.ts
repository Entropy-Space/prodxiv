import { describe, expect, test } from "bun:test";

import { ExitCode, PaperbotError } from "@prodxiv/paperbot-core";
import {
  formatAgentProgress,
  githubRepositoryLabel,
  summarizeAgentError,
} from "../src/agent/progress.ts";

describe("agent progress", () => {
  test("formats a bounded transcript line with project and session context", () => {
    expect(
      formatAgentProgress(
        {
          kind: "host",
          session_role: "evidence",
          operation: "validate_evidence",
          status: "retrying",
          summary:
            "2 evidence ranges failed validation;\nrequesting correction 1/2",
        },
        {
          project_index: 1,
          project_count: 3,
          repository_label: "owner/repo",
        },
      ),
    ).toBe(
      "paperbot: [1/3 owner/repo] [evidence] host(validate_evidence): retrying — 2 evidence ranges failed validation; requesting correction 1/2",
    );
  });

  test("shows safe metrics without exposing model response text", () => {
    expect(
      formatAgentProgress(
        {
          kind: "conversation",
          session_role: "author",
          message_role: "assistant",
          operation: "initial_draft",
          status: "completed",
          summary:
            "Submitted a draft with 4 topics, 3 assumptions, and 13 evidence references",
          duration_ms: 52_800,
          input_tokens: 41_250,
          output_tokens: 4_930,
          response_byte_count: 8_192,
        },
        { repository_label: "owner/repo" },
      ),
    ).toBe(
      "paperbot: [owner/repo] [author] assistant: Submitted a draft with 4 topics, 3 assumptions, and 13 evidence references (52.8s, tokens=41250/4930, response=8.0KiB)",
    );
  });

  test("normalizes provider failures without printing their response body", () => {
    const summary = summarizeAgentError(
      new PaperbotError(
        "Pi agent failed: HTTP 400 response body contained private draft text",
        ExitCode.remote,
      ),
    );

    expect(summary).toBe("Remote request failed — HTTP 400");
    expect(summary).not.toContain("private draft text");
  });

  test("uses only canonical GitHub owner and repository labels", () => {
    expect(
      githubRepositoryLabel("https://github.com/Owner/repository.git"),
    ).toBe("Owner/repository");
    expect(githubRepositoryLabel("/private/work/repository")).toBe("local");
    expect(
      githubRepositoryLabel("https://example.com/private/repository"),
    ).toBe("remote");
  });
});
