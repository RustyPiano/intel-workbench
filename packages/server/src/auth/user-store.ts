import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { DataPaths } from "../data/paths.js";
import type { Clearance, Role } from "../domain/types.js";

/**
 * 本地用户存储（工程方案 §4.2，`config/users.json`）。口令以 scrypt 加盐哈希
 * 落盘，绝不明文。预置三角色（演示口令，可由管理员后续重置）。
 */

export interface StoredUser {
  id: string;
  name: string;
  role: Role;
  clearance: Clearance;
  enabled: boolean;
  /** `scrypt:<saltHex>:<dkHex>`，仅服务端持有，不回前端。 */
  pwd_hash: string;
}

export type PublicUser = Omit<StoredUser, "pwd_hash">;

const SCRYPT_KEYLEN = 64;

/** 口令哈希：随机盐 + scrypt，自描述格式便于校验。 */
export function hashPassword(plain: string): string {
  const salt = randomBytes(16);
  const dk = scryptSync(plain, salt, SCRYPT_KEYLEN);
  return `scrypt:${salt.toString("hex")}:${dk.toString("hex")}`;
}

/** 恒定时间比对，避免计时侧信道。 */
export function verifyPassword(plain: string, stored: string): boolean {
  const parts = stored.split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1], "hex");
  const expected = Buffer.from(parts[2], "hex");
  if (expected.length === 0) return false;
  let dk: Buffer;
  try {
    dk = scryptSync(plain, salt, expected.length);
  } catch {
    return false;
  }
  return timingSafeEqual(expected, dk);
}

/** 首次启动预置（演示口令；§8.14 支持后续重置）。 */
const SEED_DEFAULTS: { user: PublicUser; password: string }[] = [
  { user: { id: "admin", name: "管理员", role: "admin", clearance: "topsecret", enabled: true }, password: "admin123" },
  { user: { id: "operator", name: "作业员", role: "operator", clearance: "confidential", enabled: true }, password: "operator123" },
  { user: { id: "security", name: "保密员", role: "security", clearance: "topsecret", enabled: true }, password: "security123" },
];

export class UserStore {
  constructor(private readonly paths: DataPaths) {}

  async list(): Promise<PublicUser[]> {
    return (await this.read()).map(({ pwd_hash: _pwd, ...u }) => u);
  }

  async findById(id: string): Promise<StoredUser | undefined> {
    return (await this.read()).find((u) => u.id === id);
  }

  private async read(): Promise<StoredUser[]> {
    try {
      return JSON.parse(await readFile(this.paths.usersFile, "utf8")) as StoredUser[];
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        const seeded = SEED_DEFAULTS.map(({ user, password }) => ({ ...user, pwd_hash: hashPassword(password) }));
        await this.write(seeded);
        return seeded;
      }
      throw e;
    }
  }

  private async write(users: StoredUser[]): Promise<void> {
    await mkdir(path.dirname(this.paths.usersFile), { recursive: true });
    await writeFile(this.paths.usersFile, `${JSON.stringify(users, null, 2)}\n`, "utf8");
  }
}
