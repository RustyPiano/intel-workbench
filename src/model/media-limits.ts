// DashScope Qwen-Omni requires the Base64-encoded local-file payload itself to
// be smaller than 10MB. Use decimal MB rather than MiB so the local guard is
// conservative when provider docs say "MB".
export const MAX_INLINE_BASE64_BYTES = 10_000_000;

export function base64EncodedLength(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4;
}
