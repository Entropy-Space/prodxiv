import { Marked, Renderer } from "marked";
import sanitizeHtml from "sanitize-html";

export interface RenderedPaperMarkdown {
  html: string;
  section_headings: Array<{
    slug: string;
    text: string;
  }>;
}

export class PublishedPaperFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishedPaperFormatError";
  }
}

export function renderPaperMarkdown(
  sourceMarkdown: string,
): RenderedPaperMarkdown {
  const markdown = extractMarkdownBody(sourceMarkdown);
  const section_headings: RenderedPaperMarkdown["section_headings"] = [];
  const usedSlugs = new Map<string, number>();
  const renderer = new Renderer();

  renderer.heading = function (token) {
    const text = token.text.trim();
    const slug = uniqueSlug(text, usedSlugs);
    if (token.depth === 1) {
      section_headings.push({ slug, text });
    }
    const content = this.parser.parseInline(token.tokens);
    return `<h${token.depth} id="${slug}">${content}</h${token.depth}>\n`;
  };

  const parser = new Marked({
    gfm: true,
    renderer,
  });
  const rendered = parser.parse(markdown);
  if (typeof rendered !== "string") {
    throw new PublishedPaperFormatError(
      "published Markdown unexpectedly rendered asynchronously",
    );
  }

  return {
    html: sanitizeHtml(rendered, {
      allowedTags: sanitizeHtml.defaults.allowedTags,
      allowedAttributes: {
        a: ["href", "title", "rel"],
        code: ["class"],
        h1: ["id"],
        h2: ["id"],
        h3: ["id"],
        h4: ["id"],
        h5: ["id"],
        h6: ["id"],
      },
      allowedSchemes: ["http", "https", "mailto"],
      transformTags: {
        a: (_tagName, attributes) => ({
          tagName: "a",
          attribs:
            attributes.href?.startsWith("http") === true
              ? {
                  ...attributes,
                  rel: "noopener noreferrer",
                }
              : attributes,
        }),
      },
    }),
    section_headings,
  };
}

function extractMarkdownBody(sourceMarkdown: string): string {
  const source = sourceMarkdown.startsWith("\uFEFF")
    ? sourceMarkdown.slice(1)
    : sourceMarkdown;
  const lineEnding = source.startsWith("---\r\n")
    ? "\r\n"
    : source.startsWith("---\n")
      ? "\n"
      : undefined;
  if (lineEnding === undefined) {
    throw new PublishedPaperFormatError(
      "published source is missing YAML front matter",
    );
  }
  const openingLength = 3 + lineEnding.length;
  const closingDelimiter = `${lineEnding}---${lineEnding}`;
  const closingIndex = source.indexOf(closingDelimiter, openingLength);
  if (closingIndex === -1) {
    throw new PublishedPaperFormatError(
      "published source has unterminated YAML front matter",
    );
  }
  return source.slice(closingIndex + closingDelimiter.length);
}

function uniqueSlug(text: string, usedSlugs: Map<string, number>): string {
  const base =
    text
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "section";
  const count = usedSlugs.get(base) ?? 0;
  usedSlugs.set(base, count + 1);
  return count === 0 ? base : `${base}-${count + 1}`;
}
