import { customAlphabet } from "nanoid";

const idGenerator = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 10);

export function createId(prefix: string): string {
  return `${prefix}_${idGenerator()}`;
}
