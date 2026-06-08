import { createHash } from "node:crypto";

/** 内容哈希（Citation 的 content_hash 等用途，§4.3）。 */
export function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** 短随机 id（素材等业务标识，非密码学用途）。 */
export function shortId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
