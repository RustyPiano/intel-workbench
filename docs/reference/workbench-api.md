# Intel Workbench API 参考

本文只记录稳定入口和关键契约。运行中的完整路由清单以 `GET /api/_routes` 为准；字段类型以 `packages/server/src/domain/types.ts` 和 Web API 类型为准。

## 基础约定

- Base path：`/api`
- 鉴权：除 health、登录和路由索引外，请求使用 `Authorization: Bearer <token>`
- 成功响应：顶层 `ok: true`
- 失败响应：使用对应 HTTP 状态码和用户可读错误，不把 4xx 伪装成 200
- 专题访问同时受角色、写权限和 clearance 约束；前端隐藏按钮不是安全边界

## 运行状态

`GET /api/health`

```json
{
  "ok": true,
  "devMode": false,
  "networkMode": "offline",
  "modelConfigured": true
}
```

`networkMode` 只有 `offline` 或 `restricted-cloud`。Health 不返回模型端点、白名单明细、API key 或其他秘密。

## 鉴权

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/auth/login` | 用户名/密码登录 |
| GET | `/api/auth/me` | 当前身份 |
| POST | `/api/auth/change-password` | 修改本人密码；成功后旧会话失效 |
| POST | `/api/auth/logout` | 注销当前会话 |

管理员禁用用户、修改角色、密级或密码时，该用户现有会话全部吊销。

## 专题与素材

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/api/cases` | 列表/创建专题 |
| GET/PATCH | `/api/cases/:id` | 读取/更新专题；可更新 autopilot 开关 |
| GET | `/api/cases/:id/materials` | 素材列表 |
| POST | `/api/cases/:id/materials` | 小文件 JSON 真批量上传，body 为 `{files:[...]}` |
| POST | `/api/cases/:id/materials/upload` | 流式上传单文件，文件名在 `x-upload-filename` |
| POST | `/api/cases/:id/materials/settle` | 收口 defer 批次并触发下游 |
| POST | `/api/cases/:id/materials/:mid/process` | 显式加工/重试 |
| POST | `/api/cases/:id/materials/:mid/reindex` | 重建索引 |
| DELETE | `/api/cases/:id/materials/:mid` | 删除素材与派生产物 |

流式批量上传时，除最后收口外，每个 upload 请求应带 `x-upload-batch: defer`；所有文件落盘后调用 `/settle`。缺少该协议可能让调用方提前启动自动流水线。

## 分析与问答

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST/DELETE | `/api/cases/:id/inquiries` | 列表、发问、清空（清空要求写权限） |
| POST | `/api/cases/:id/inquiries/stream` | SSE 流式问答 |
| GET/POST | `/api/cases/:id/elements` | 读取/抽取要素 |
| GET/POST | `/api/cases/:id/contradictions` | 读取/检测矛盾 |
| PATCH | `/api/cases/:id/contradictions/:contradictionId/acknowledge` | 独立处置台账 |
| POST | `/api/cases/:id/jobs/:kind/start` | 启动 `elements/contradictions/auto-inquiry` |
| GET | `/api/cases/:id/jobs/:kind/status` | 查询内存 job 状态 |
| POST | `/api/cases/:id/jobs/:kind/cancel` | 取消 job |
| GET | `/api/cases/:id/brief` | 研判简报；`?refresh=1` 请求重算 |

自动研判的持久化进度来自 `auto-inquiry.json`，不以内存 job 是否仍存在作为唯一事实源。

## Finding 与报告

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/api/cases/:id/findings` | 列表/创建 Finding |
| POST | `/api/cases/:id/findings/:findingId/review` | security/admin 复核 |
| GET | `/api/cases/:id/report` | 当前报告记录 |
| GET | `/api/cases/:id/report/coverage` | 五节软覆盖率 |
| POST | `/api/cases/:id/report/auto-draft` | 生成建议稿，不直接保存 |
| POST | `/api/cases/:id/report/draft` | 保存并渲染新 revision |
| POST | `/api/cases/:id/report/submit` | 提交复核 |
| POST | `/api/cases/:id/report/approve` | security/admin 核准 |
| POST | `/api/cases/:id/report/export` | 通过导出闸后导出 |

报告状态机：

```text
draft → in_review → approved → exported
```

`revision + contentHash` 绑定审批内容。重新起草会清空旧审批；spec 或 markdown 漂移后，提交、核准、导出返回 409。

## 审计与管理

- `GET /api/cases/:id/audit`：可读专题者可查看本专题审计镜像。
- `GET /api/audit`、`GET /api/audit/verify`、`POST /api/audit/export`：仅 security/admin 且需相应密级。
- `/api/admin/*`：用户、提示词、模型状态和 skill 管理，仅 admin。

全局审计文件是权威链，专题日志是便于专题内查看的镜像；镜像写失败不能改变下一条全局链头。
