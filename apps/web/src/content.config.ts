import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";

import {
  evidenceBundleSchema,
  paperMetadataSchema,
} from "./lib/canonical-schemas";

const papers = defineCollection({
  loader: glob({
    base: "../../examples/papers",
    pattern: "**/*.md",
  }),
  schema: paperMetadataSchema,
});

const evidence = defineCollection({
  loader: glob({
    base: "../../examples/papers",
    pattern: "**/*.json",
  }),
  schema: evidenceBundleSchema,
});

export const collections = { evidence, papers };
