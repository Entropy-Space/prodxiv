import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

const paperStatus = z.enum([
  "concept",
  "private_beta",
  "public_beta",
  "launched",
  "discontinued",
]);

const papers = defineCollection({
  loader: glob({
    base: "../../examples/papers",
    pattern: "**/*.md",
  }),
  schema: z.object({
    schema_version: z.string(),
    paper_id: z.string(),
    title: z.string(),
    summary: z.string(),
    authors: z.array(
      z.object({
        name: z.string(),
      }),
    ),
    organization: z.string().optional(),
    published_at: z.string(),
    version: z.number().int().positive(),
    status: paperStatus,
    topics: z.array(z.string()),
    license: z.string(),
    product_url: z.url().optional(),
    repository_url: z.url().optional(),
  }),
});

export const collections = { papers };
