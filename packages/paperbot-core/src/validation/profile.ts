export const validation_profiles = [
  "draft",
  "submission",
  "publication",
] as const;

export type ValidationProfile = (typeof validation_profiles)[number];
