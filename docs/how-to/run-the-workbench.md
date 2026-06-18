# 运行 intel-workbench（离线情报分析工作台）

从零把整个项目跑起来。面向开发/演示（dev 模式）。

---

## 组件与端口

| 组件 | 端口 | 说明 |
|---|---|---|
| 工作台后端 | `:4319` | Express，`npm run dev:server` |
| 工作台前端 | Vite（默认 `:5173`） | React，`npm run dev:web`，代理 `/api`→`:4319` |
| 文本 LLM（问答） | 云 | DeepSeek（`api.deepseek.com`，OpenAI 兼容）→ 部署换本地 |
| Embed / Rerank / VLM | 云 | 硅基流动（`api.siliconflow.cn/v1`）→ 部署换本地 |
| OCR | 本地 `:8000` | PaddleOCR 服务（`../paddleocr`，独立 uv 项目） |
| ASR | 本地 `:8001` | FunASR 服务（`../funasr`，独立 uv 项目，带时间戳+说话人） |

> 模型服务是**独立项目**（`../paddleocr`、`../funasr`），不在本仓库内。云端点是 dev 替身，部署到气隙机时全部换本地端点即可。

---

## 一、一次性准备

### 1. 工作台依赖（monorepo）
```bash
cd <本仓库>            # .../mini-agent
npm install            # 安装 core/server/web 全部工作区依赖
```

### 2. 本地模型服务（两个 sibling 项目，各自 uv）
```bash
cd ../paddleocr && uv sync     # OCR 依赖
cd ../funasr   && uv sync      # ASR 依赖（torch + funasr，较大）
```
> 各服务**首次启动**会联网拉模型权重（PaddleOCR ~百 MB；FunASR ~2GB → `~/.cache/modelscope`），之后离线缓存秒起。这台 dev 机需要一次联网；最终气隙部署机预先把缓存带过去即可。

### 3. 配置密钥
编辑仓库根的 `dev.env.sh`（已 gitignore，**绝不入库**），填两把 key：
```bash
export SILICONFLOW_API_KEY="sk-你的硅基流动key"   # Embed/Rerank/VLM 共用
export DEEPSEEK_API_KEY="sk-你的DeepSeek-key"      # 文本问答
```
其余端点/模型/维度已填好。ASR 走本地 FunASR，无需 key。

---

## 二、每次启动（开 4~5 个终端，或后台）

```bash
# 终端 A — 本地 OCR 服务
cd ../paddleocr && uv run python server.py        # → 127.0.0.1:8000

# 终端 B — 本地 ASR 服务
cd ../funasr && uv run python server.py           # → 127.0.0.1:8001（等日志出现 "Uvicorn running"）

# 终端 C — 工作台后端（先 source 环境变量！）
cd <本仓库> && source dev.env.sh && npm run dev:server     # → :4319

# 终端 D — 工作台前端
cd <本仓库> && npm run dev:web                     # 打开它提示的 URL（通常 http://localhost:5173）
```

> **关键**：跑后端的终端必须先 `source dev.env.sh`，否则模型端点/key 读不到，问答与检索会降级/报错。
> 服务就绪自检：`curl 127.0.0.1:8000/health` 和 `curl 127.0.0.1:8001/health` 都应返回 `{"status":"ok","warmed":true}`。

---

## 三、在浏览器里验收

1. 打开前端 URL → **登录**（dev 默认账号，见下）。
2. **新建专题** → 进入工作台。
3. **汇入材料**（MaterialsPanel "汇入"）：传文档(PDF/Word/txt)、图片、音频(wav/mp3) → 看解析/OCR/转写结果。
4. **问答**（InquiryPanel）：提问 → 流式回答 + **逐条溯源**（点引用跳回原文/音频时间码）。
5. **要素**：抽取人物/装备/地点等结构化实体。
6. **报告**：起草 → 复核 → 批准 → 导出。
7. **审计**：查看哈希链审计日志、verify。

**dev 默认账号**（首次启动自动种入 `config/users.json`，scrypt 加盐哈希）：

| 账号 | 口令 | 角色 / 密级 |
|---|---|---|
| `admin` | `admin123` | 管理员 / 绝密 |
| `operator` | `operator123` | 作业员 / 机密 |
| `security` | `security123` | 保密员 / 绝密 |

> ⚠️ 这是 dev 种子口令，**真实部署务必改掉**（后台用户管理改密；或删 `config/users.json` 重新种）。

---

## 四、只想跑测试 / 不连真模型

```bash
source dev.env.sh   # 可选；测试是 hermetic 的
npm run check       # typecheck + 全量 vitest（不连任何真模型）
```
- 结果应为 **N passed / 2 skipped**。那 2 个 skip 是环境性假失败（`api.test.ts` 需 TCP、`bash.test.ts` 偶发），正常。

**不起某个模型服务也能跑**（降级而非崩溃）：
- 不起 PaddleOCR → 扫描件/图片 OCR 这一路降级；
- 不起 FunASR → 音频转写降级；
- 不填某云 key → 该能力降级（如不填 Embed key → 检索退化为 BM25 词面）。
- 想纯用确定性 mock 跑通媒体管线：`export MINI_AGENT_USE_MOCK_MEDIA=true`（不连真模型，出假数据）。

---

## 五、部署到气隙机（生产）

1. 预先在联网机把 PaddleOCR / FunASR 的模型缓存拉好，连同两个 uv 项目带到气隙机。
2. 把云端点全换成本地端点（改 `dev.env.sh` 或生产环境变量）：
   - 文本 LLM：DeepSeek → 本地 Ollama / vLLM（OpenAI 兼容口）；
   - Embed / Rerank / VLM：硅基流动 → 本地开源模型 HTTP 服务（OpenAI 兼容；Rerank 用 Jina/Cohere 式 `/rerank`）；
   - OCR / ASR：已是本地（PaddleOCR / FunASR），不变。
3. 断网运行。零外发红线（`OfflineGuard`）会把任何非白名单出站拦下并审计——白名单只含你配置的本地端点 host。

---

## 六、故障排查

| 症状 | 多半原因 |
|---|---|
| OCR / 语音上传后无结果、材料停在 pending | 对应本地服务没起（`curl :8000/health` / `:8001/health` 自检） |
| 问答报错 / 答非所问 | 跑后端的终端没 `source dev.env.sh`，或 DeepSeek key 未填 |
| 向量检索没生效（只像关键词匹配） | Embed key 未填（退化 BM25），或 `.vec` 是旧 mock 索引（重新汇入材料即重建） |
| 端口被占（8000/8001/4319/5173） | 已有同名进程在跑，先停掉旧的 |
| 首次起 FunASR 卡很久 | 在拉 ~2GB 模型（看日志下载进度），等一次即可，之后缓存秒起 |

---

更深的架构/红线/扩展见 **[../HANDOFF.md](../HANDOFF.md)** 与 **[../architecture-explained.html](../architecture-explained.html)**。
