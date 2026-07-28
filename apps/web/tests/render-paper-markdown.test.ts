import { describe, expect, test } from "bun:test";

import {
  PublishedPaperFormatError,
  renderPaperMarkdown,
} from "../src/lib/render-paper-markdown.ts";

describe("renderPaperMarkdown", () => {
  test("removes front matter and creates stable section anchors", () => {
    const rendered = renderPaperMarkdown(`---
schema_version: "1"
title: "Example"
---
# Summary

First.

# Summary

Second.
`);

    expect(rendered.section_headings).toEqual([
      { slug: "summary", text: "Summary" },
      { slug: "summary-2", text: "Summary" },
    ]);
    expect(rendered.html).toContain('<h1 id="summary">Summary</h1>');
    expect(rendered.html).toContain('<h1 id="summary-2">Summary</h1>');
    expect(rendered.html).not.toContain("schema_version");
  });

  test("sanitizes raw HTML and unsafe links", () => {
    const rendered = renderPaperMarkdown(`---
schema_version: "1"
---
# Summary

<script>alert("unsafe")</script>

[unsafe](javascript:alert("unsafe"))

[external](https://example.com)
`);

    expect(rendered.html).not.toContain("<script");
    expect(rendered.html).not.toContain("javascript:");
    expect(rendered.html).toContain('rel="noopener noreferrer"');
  });

  test("rejects source without complete front matter", () => {
    expect(() => renderPaperMarkdown("# Summary")).toThrow(
      PublishedPaperFormatError,
    );
    expect(() =>
      renderPaperMarkdown('---\nschema_version: "1"\n# Summary'),
    ).toThrow("unterminated YAML front matter");
  });
});
