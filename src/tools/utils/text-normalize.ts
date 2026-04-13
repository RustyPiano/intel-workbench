const TRANSLATION_TABLE = new Map<string, string>([
  ["\u2018", "'"],
  ["\u2019", "'"],
  ["\u201C", "\""],
  ["\u201D", "\""],
  ["\u2013", "-"],
  ["\u2014", "-"],
  ["\u00A0", " "],
  ["\u2002", " "],
  ["\u2003", " "],
  ["\u2009", " "],
]);

export function normalizeTextForEditing(input: string): string {
  return input.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
}

export function normalizeForMatching(input: string): { text: string; indexMap: number[] } {
  const normalizedSource = normalizeTextForEditing(input);
  let output = "";
  const indexMap: number[] = [];

  for (let index = 0; index < normalizedSource.length; index += 1) {
    const char = normalizedSource[index] ?? "";
    output += TRANSLATION_TABLE.get(char) ?? char;
    indexMap.push(index);
  }

  indexMap.push(normalizedSource.length);

  return {
    text: output,
    indexMap,
  };
}

export function normalizeNeedle(input: string): string {
  const normalizedSource = normalizeTextForEditing(input);
  let output = "";

  for (const char of normalizedSource) {
    output += TRANSLATION_TABLE.get(char) ?? char;
  }

  return output;
}
