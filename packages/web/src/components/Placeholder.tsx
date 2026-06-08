import type { ReactNode } from "react";

/**
 * Empty-state / "该能力暂不可用" presentation (产品 spec §10).
 *
 * M0 screens are all placeholders: they must NOT fabricate data and must NOT
 * throw. Each renders a short Chinese label saying what it will become and a
 * neutral "暂不可用 / 待加工" hint.
 */
export function PlaceholderPanel({
  title,
  becomes,
  note,
  children,
}: {
  /** What this screen/panel is. */
  title: string;
  /** Chinese sentence: what it will become in M1+. */
  becomes: string;
  /** Optional extra hint (defaults to the §10 degraded line). */
  note?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="placeholder">
      <div className="placeholder__badge">该能力暂不可用 · M0 占位</div>
      <h2 className="placeholder__title">{title}</h2>
      <p className="placeholder__becomes">{becomes}</p>
      <p className="placeholder__note">
        {note ?? "此页为横向骨架占位：界面可进入、可导航，但具体能力将在后续里程碑接通。当前不展示任何虚构数据。"}
      </p>
      {children ? <div className="placeholder__extra">{children}</div> : null}
    </section>
  );
}

/** A compact empty-state used inside list-style screens. */
export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="empty-state">
      <div className="empty-state__title">{title}</div>
      {hint ? <div className="empty-state__hint">{hint}</div> : null}
    </div>
  );
}
