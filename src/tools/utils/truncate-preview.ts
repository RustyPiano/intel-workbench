/**
 * Collapse whitespace and cap a string to a short preview, used when surfacing
 * model/ASR output in an error `content` without dumping the whole payload.
 */
export function truncatePreview(text: string, maxLength = 500): string {
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3)}...`;
}
