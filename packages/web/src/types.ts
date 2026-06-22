// 角色（产品 spec §3）。
export type Role = "operator" | "admin" | "security";

// 密级分级（工程方案 §11：内部 / 秘密 / 机密 / 绝密）。
export type Clearance = "internal" | "secret" | "confidential" | "topsecret";

export const ROLE_LABELS: Record<Role, string> = {
  operator: "作业员",
  admin: "管理员",
  security: "保密员",
};

export const CLEARANCE_LABELS: Record<Clearance, string> = {
  internal: "内部",
  secret: "秘密",
  confidential: "机密",
  topsecret: "绝密",
};

export interface SessionUser {
  /** 稳定用户标识（开发期 = `dev-<role>`）；作为审计 user 与请求头 x-user-id。 */
  id: string;
  name: string;
  role: Role;
  clearance: Clearance;
  mustChangePassword?: boolean;
}
