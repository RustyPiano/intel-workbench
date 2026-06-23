import { Navigate, Route, Routes } from "react-router-dom";

import { RequireRole, RequireSession } from "./components/Guards";
import { AdminLayout } from "./layouts/AdminLayout";
import { OperatorLayout } from "./layouts/OperatorLayout";
import {
  AdminModelsPage,
  AdminPromptsPage,
  AdminSkillsPage,
  AdminUsersPage,
} from "./pages/Admin";
import { AuditCenterPage } from "./pages/AuditCenter";
import { CaseListPage } from "./pages/CaseList";
import {
  CaseAuditPanel,
  CaseWorkbench,
  ContradictionsPanel,
  ElementsPanel,
  FindingsPanel,
  InquiryPanel,
  MaterialsPanel,
  ReportPanel,
} from "./pages/CaseWorkbench";
import { LoginPage } from "./pages/Login";
import { NewCasePage } from "./pages/NewCase";
import { OverviewPage } from "./pages/Overview";

/**
 * §8 全路由（横向骨架）：每屏可进入、可从导航到达。
 * 双面分离：作业面（OperatorLayout）/ 管理面（AdminLayout，仅管理员）。
 */
export function App() {
  return (
    <Routes>
      {/* 登录壳 */}
      <Route path="/login" element={<LoginPage />} />

      {/* 作业面 */}
      <Route
        element={
          <RequireSession>
            <OperatorLayout />
          </RequireSession>
        }
      >
        <Route path="/" element={<CaseListPage />} />
        <Route path="/overview" element={<OverviewPage />} />
        <Route path="/cases/new" element={<NewCasePage />} />
        <Route path="/cases/:id" element={<CaseWorkbench />}>
          <Route index element={<Navigate to="materials" replace />} />
          <Route path="materials" element={<MaterialsPanel />} />
          <Route path="elements" element={<ElementsPanel />} />
          <Route path="contradictions" element={<ContradictionsPanel />} />
          <Route path="inquiry" element={<InquiryPanel />} />
          <Route path="findings" element={<FindingsPanel />} />
          <Route path="report" element={<ReportPanel />} />
          <Route path="audit" element={<CaseAuditPanel />} />
        </Route>
      </Route>

      {/* 管理面：管理后台仅管理员；审计中心管理员/保密员均可 */}
      <Route
        path="/admin"
        element={
          <RequireRole roles={["admin"]}>
            <AdminLayout />
          </RequireRole>
        }
      >
        <Route index element={<Navigate to="prompts" replace />} />
        <Route path="prompts" element={<AdminPromptsPage />} />
        <Route path="skills" element={<AdminSkillsPage />} />
        <Route path="models" element={<AdminModelsPage />} />
        <Route path="users" element={<AdminUsersPage />} />
      </Route>

      <Route
        path="/audit"
        element={
          <RequireRole roles={["admin", "security"]}>
            <AdminLayout />
          </RequireRole>
        }
      >
        <Route index element={<AuditCenterPage />} />
      </Route>

      {/* 兜底：未知路径回首页（已登录）或登录页 */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
