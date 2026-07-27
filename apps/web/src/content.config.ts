import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";

import { paperMetadataSchema } from "./lib/paper-metadata-schema";

const papers = defineCollection({
  loader: glob({
    base: "../../examples/papers",
    pattern: "**/*.md",
  }),
  schema: paperMetadataSchema,
});

export const collections = { papers };
