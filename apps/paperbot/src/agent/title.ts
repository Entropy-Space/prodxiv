const MAX_GENERATED_TITLE_CHARACTERS = 160;
const MAX_AGENT_TITLE_CHARACTERS = 500;

export function generatedTitleDiagnostic(
  title: string,
  productName: string,
): string | undefined {
  const maximumCharacters = Math.min(
    MAX_AGENT_TITLE_CHARACTERS,
    Math.max(MAX_GENERATED_TITLE_CHARACTERS, productName.length + 60),
  );
  if (title.length === 0) {
    return "must be a non-empty string";
  }
  if (title.length > maximumCharacters) {
    return `must contain at most ${maximumCharacters} characters`;
  }
  if (title !== title.trim() || /[\u0000-\u001f\u007f]/.test(title)) {
    return "must be a single line without surrounding whitespace";
  }
  const separatorIndex = titleSeparatorIndex(title, productName);
  if (separatorIndex < 1) {
    return `must begin with ${productName} and use the form <product name>: <specific thesis>`;
  }
  const thesis = title.slice(separatorIndex + 2);
  const normalizedThesis = thesis.trim().toLocaleLowerCase("en-US");
  if (
    thesis.length === 0 ||
    /\bresearch\s+draft\b/i.test(thesis) ||
    /^(?:(?:a|the)\s+)?(?:(?:private|research)\s+)?(?:draft|paper)$/.test(
      normalizedThesis,
    ) ||
    /^(?:concept|private beta|public beta|launched|discontinued)$/.test(
      normalizedThesis,
    )
  ) {
    return "must state a specific product thesis, not a draft, paper, or status label";
  }
  return undefined;
}

function titleSeparatorIndex(title: string, productName: string): number {
  let separatorIndex = title.indexOf(": ");
  while (separatorIndex !== -1) {
    if (
      normalizedProductTitle(title.slice(0, separatorIndex)) ===
      normalizedProductTitle(productName)
    ) {
      return separatorIndex;
    }
    separatorIndex = title.indexOf(": ", separatorIndex + 2);
  }
  return -1;
}

function normalizedProductTitle(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "");
  return normalized.length === 0
    ? value.trim().toLocaleLowerCase("en-US")
    : normalized;
}
