const paperIdPrefix = "prodxiv:";
const paperSlugPattern = /^(\d{4})\.([0-9A-HJKMNPQRSTVWXYZ]{6})$/;
const maximumVersion = 4_294_967_295;

export function canonicalPaperIdFromSlug(slug: string): string | undefined {
  const match = paperSlugPattern.exec(slug);
  if (match === null) {
    return undefined;
  }
  const period = match[1];
  const suffix = match[2];
  if (period === undefined || suffix === undefined) {
    return undefined;
  }

  return `${paperIdPrefix}${period}.${suffix}`;
}

export function paperVersionFromSlug(slug: string): number | undefined {
  const match = /^v([1-9]\d*)$/.exec(slug);
  if (match === null) {
    return undefined;
  }

  const version = Number(match[1]);
  return Number.isSafeInteger(version) && version <= maximumVersion
    ? version
    : undefined;
}

export function paperSlugFromCanonicalId(paperId: string): string | undefined {
  if (!paperId.startsWith(paperIdPrefix)) {
    return undefined;
  }

  const slug = paperId.slice(paperIdPrefix.length);
  return canonicalPaperIdFromSlug(slug) === paperId ? slug : undefined;
}

export function publicPaperPath(paperId: string, version: number): string {
  const slug = paperSlugFromCanonicalId(paperId);
  if (
    slug === undefined ||
    !Number.isSafeInteger(version) ||
    version < 1 ||
    version > maximumVersion
  ) {
    throw new TypeError("invalid canonical paper identifier or version");
  }

  return `/papers/${slug}/v${version}`;
}
