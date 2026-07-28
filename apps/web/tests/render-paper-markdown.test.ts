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

  test("renders an inert inline SVG figure", () => {
    const rendered = renderPaperMarkdown(`---
schema_version: "1"
---
# Architecture

<figure>
<svg viewBox="0 0 320 120" width="320" height="120" aria-label="Draft workflow">
  <rect x="10" y="30" width="100" height="60" rx="8" fill="#f3efe4" stroke="#1f4f46" />
  <line x1="110" y1="60" x2="210" y2="60" stroke="#1f4f46" stroke-width="2" />
  <polygon points="210,60 198,53 198,67" fill="#1f4f46" />
  <text x="60" y="64" text-anchor="middle" font-size="16">Scan</text>
  <circle cx="260" cy="60" r="42" fill="none" stroke="#1f4f46" />
</svg>
<figcaption>Repository scan to private draft.</figcaption>
</figure>
`);

    expect(rendered.html).toContain("<figure>");
    expect(rendered.html).toContain(
      '<svg viewBox="0 0 320 120" width="320" height="120" aria-label="Draft workflow" role="img">',
    );
    expect(rendered.html).toContain('stroke-width="2"');
    expect(rendered.html).toContain(
      "<figcaption>Repository scan to private draft.</figcaption>",
    );
  });

  test("removes active and externally embedded SVG content", () => {
    const rendered = renderPaperMarkdown(`---
schema_version: "1"
---
# Architecture

<svg viewBox="0 0 10 10" onload="alert('unsafe')" style="display:none">
  <script>alert("unsafe")</script>
  <foreignObject><p>embedded HTML</p></foreignObject>
  <use href="https://example.com/remote.svg#shape" />
  <image href="javascript:alert('unsafe')" />
  <rect width="10" height="10" fill="red" onclick="alert('unsafe')" />
</svg>
`);

    expect(rendered.html).toContain('<svg viewBox="0 0 10 10" role="img">');
    expect(rendered.html).toContain('<rect width="10" height="10" fill="red">');
    expect(rendered.html).not.toContain("onload");
    expect(rendered.html).not.toContain("onclick");
    expect(rendered.html).not.toContain("style=");
    expect(rendered.html).not.toContain("<script");
    expect(rendered.html).not.toContain("embedded HTML");
    expect(rendered.html).not.toContain("<use");
    expect(rendered.html).not.toContain("<image");
    expect(rendered.html).not.toContain("javascript:");
    expect(rendered.html).not.toContain("remote.svg");
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
