// DashScope Qwen-Omni requires the Base64-encoded local-file payload itself to
// be smaller than 10MB. Use decimal MB rather than MiB so the local guard is
// conservative when provider docs say "MB".
export const MAX_INLINE_BASE64_BYTES = 10_000_000;

// Doubao 极速版 (turbo) accepts inline base64 audio. The docs recommend keeping
// the uploaded stream within ~20MB (egress-bandwidth dependent) and cap the
// whole audio at 100MB. We base64 the raw file, so guard the raw byte size:
// default to the 20MB recommendation, and never allow past the 100MB ceiling.
export const DEFAULT_ASR_TURBO_MAX_BYTES = 20_000_000;
export const ASR_TURBO_HARD_MAX_BYTES = 100_000_000;

export function base64EncodedLength(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4;
}
