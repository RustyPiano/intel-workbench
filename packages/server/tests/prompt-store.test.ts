import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { GenerateInput, GenerateResult, ModelAdapter } from "mini-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AdminService } from "../src/admin/admin-service.js";
import { DEFAULT_PROMPT_BODIES, PromptStore, REGISTERED_PROMPTS } from "../src/admin/prompt-store.js";
import { AuditService } from "../src/audit/audit-service.js";
import { UserStore } from "../src/auth/user-store.js";
import { CaseService } from "../src/cases/case-service.js";
import { resolveDataPaths, type DataPaths } from "../src/data/paths.js";
import type { Chunk, Element, Identity, Inquiry } from "../src/domain/types.js";
import { ElementService } from "../src/elements/element-service.js";
import { InquiryService } from "../src/inquiry/inquiry-service.js";
import { MaterialService } from "../src/materials/material-service.js";
import type { ModelConfig } from "../src/model/model-config.js";
import { OfflineGuard } from "../src/security/offline-guard.js";

const ADMIN: Identity = { id: "admin", name: "admin", role: "admin", clearance: "topsecret" };
const OPERATOR: Identity = { id: "op", name: "op", role: "operator", clearance: "internal" };
const ENDPOINT = "https://stub.local/v1";
const UNCONFIGURED: ModelConfig = { configured: false, provider: "openai-compatible", model: "", baseURL: "", apiKey: "", host: "" };

const EXPECTED_DEFAULTS = {
  "inquiry-methodology": [
    "你是情报分析助手。只依据本专题检索到并引用的素材片段作答，不得使用片段之外的知识。",
    "流程：search_chunks 检索→read_chunk 读全文→对每条结论 cite(chunk_id,claim,quote) 接地（quote 必须是原文逐字支撑句，且仅哈希校验通过的引用有效）→保存 cite 返回的 cite_id→最后调一次 finalize_answer 提交所有 claims 及其 cite_ids（必须使用返回的 cite_id，不是 chunk_id）。",
    "材料不足就如实说明，不要编造。",
  ].join("\n"),
  "inquiry-structured": [
    "你是情报分析助手。只能依据下方带编号的素材片段回答，不得使用片段之外的任何知识或常识。",
    "每条结论必须在 citations 中引用支撑它的片段编号（chunk_id）。",
    "若给定片段不足以支撑任何结论，置 insufficient=true。",
    "只输出 JSON，不要任何额外文字。schema：",
    '{"claims":[{"text":"结论文本","type":"fact|inference","citations":["chunk_id"]}],"insufficient":false}',
  ].join("\n"),
  "element-extract": [
    "你是情报分析助手。只能依据下方带编号的素材片段，抽取其中明确出现的情报要素（实体）。",
    "要素类型仅限：person(人物) org(组织/机构) location(地点) event(事件) equipment(装备) time(时间)。",
    "每个要素必须在 mentions 中给出支撑它的片段编号 chunk_id（必须来自给定片段）。",
    "不得臆造给定片段之外的要素。只输出 JSON，不要任何额外文字。schema：",
    '{"elements":[{"name":"名称","type":"person|org|location|event|equipment|time","aliases":["别名"],"mentions":[{"chunk_id":"<chunk_id>"}]}]}',
  ].join("\n"),
  "contradiction-extract": [
    "你是一名情报分析员，负责从情报文本中提取原子事实性声明。",
    "只能依据用户提供的 chunk 内容抽取，不得捏造事实，不得输出给定片段之外的信息。",
    "请仅输出JSON，格式为 {\"claims\":[{\"entity\":\"实体\",\"attribute\":\"属性\",\"value\":\"取值\",\"chunk_id\":\"<chunk_id>\"}]}。",
  ].join("\n"),
  "contradiction-judge": [
    "你是一名情报分析员，负责判断两条声明是否矛盾。",
    "只判断用户提供的 claim_a 和 claim_b，不得引入外部知识。",
    "请仅输出JSON，格式为 {\"relation\":\"contradiction|agreement|unrelated\",\"rationale\":\"理由\",\"certainty\":0.0}。",
    "relation只能是 contradiction、agreement 或 unrelated；certainty范围[0,1]。",
  ].join("\n"),
  "chunk-context": "给定整篇文档与其中一个片段，用一句话写出该片段在全文中的定位/情境（便于检索），只输出这句话、不复述原文、不解释。",
  "query-rewrite": "把用户的检索问题改写成一个更利于全文检索的查询：补全省略的主体、展开同义/相关术语、去除口语和指代，只输出改写后的查询本身，不要解释。",
  "query-hyde": '针对用户的问题，写一段简短的、假设性的"理想答案"段落（2-3 句，情报简报口吻），用于向量检索。只输出该段落，不要前后缀。',
} as const;

type PromptId = keyof typeof EXPECTED_DEFAULTS;

function promptIds(): PromptId[] {
  return [
    "chunk-context",
    "contradiction-extract",
    "contradiction-judge",
    "element-extract",
    "inquiry-methodology",
    "inquiry-structured",
    "query-hyde",
    "query-rewrite",
  ];
}

function adapterReturning(content: () => string, inputs: GenerateInput[]): ModelAdapter {
  return {
    name: "capture",
    async generate(input: GenerateInput): Promise<GenerateResult> {
      inputs.push(input);
      return { message: { role: "assistant", content: content() }, stopReason: "end_turn" };
    },
  };
}

function stripInquiry(inquiry: Inquiry): Omit<Inquiry, "id" | "ts"> {
  const { id: _id, ts: _ts, ...stable } = inquiry;
  return stable;
}

function stripElement(element: Element): Omit<Element, "id"> {
  const { id: _id, ...stable } = element;
  return stable;
}

describe("PromptStore 受管提示词（P3.B-3a）", () => {
  let root: string;
  let paths: DataPaths;
  let audit: AuditService;
  let store: PromptStore;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "iw-prompts-"));
    paths = resolveDataPaths(root);
    audit = new AuditService(paths);
    store = new PromptStore(paths, audit);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("无覆盖文件时返回字节级默认提示词", async () => {
    expect(REGISTERED_PROMPTS.map((p) => p.id).sort()).toEqual(promptIds().sort());
    for (const id of promptIds()) {
      expect(DEFAULT_PROMPT_BODIES[id]).toBe(EXPECTED_DEFAULTS[id]);
      expect(await store.getBody(id)).toBe(EXPECTED_DEFAULTS[id]);
      await expect(store.getDetail(id)).resolves.toMatchObject({
        id,
        body: EXPECTED_DEFAULTS[id],
        isDefault: true,
        healthy: true,
        versions: [],
      });
    }
    expect(await store.list()).toEqual(
      expect.arrayContaining(promptIds().map((id) => expect.objectContaining({ id, edited: false, version: 0, healthy: true }))),
    );
  });

  it("编辑时写当前文件、归档前一版并追加可校验审计", async () => {
    const body = "new element prompt";

    await store.update(ADMIN, "element-extract", body);

    expect(await readFile(path.join(paths.configDir, "prompts", "element-extract.md"), "utf8")).toBe(body);
    expect(await store.getBody("element-extract")).toBe(body);
    const versions = await store.listVersions("element-extract");
    expect(versions).toHaveLength(1);
    expect(versions[0]?.bytes).toBe(Buffer.byteLength(EXPECTED_DEFAULTS["element-extract"], "utf8"));
    expect(await store.getVersion("element-extract", versions[0]!.ts)).toBe(EXPECTED_DEFAULTS["element-extract"]);
    await expect(store.getDetail("element-extract")).resolves.toMatchObject({ isDefault: false, version: 2, healthy: true });

    const events = await audit.readAll();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      user: ADMIN.id,
      action: "prompt.update",
      object: "prompt:element-extract",
      detail: { id: "element-extract", bytes: body.length },
    });
    await expect(audit.verify()).resolves.toMatchObject({ ok: true, count: 1 });
  });

  it("可从历史版本读回并再次更新完成回滚", async () => {
    await store.update(ADMIN, "inquiry-structured", "first custom body");
    const [defaultVersion] = await store.listVersions("inquiry-structured");
    await store.update(ADMIN, "inquiry-structured", "second custom body");

    const afterSecond = await store.listVersions("inquiry-structured");
    expect(afterSecond).toHaveLength(2);
    expect(await store.getVersion("inquiry-structured", afterSecond[1]!.ts)).toBe("first custom body");

    const rollbackBody = await store.getVersion("inquiry-structured", defaultVersion!.ts);
    await store.update(ADMIN, "inquiry-structured", rollbackBody);

    expect(await store.getBody("inquiry-structured")).toBe(EXPECTED_DEFAULTS["inquiry-structured"]);
    const afterRollback = await store.listVersions("inquiry-structured");
    expect(afterRollback).toHaveLength(3);
    expect(await store.getVersion("inquiry-structured", afterRollback[2]!.ts)).toBe("second custom body");
  });

  it("未知提示词 id 拒绝详情和更新", async () => {
    await expect(store.getDetail("missing")).rejects.toMatchObject({ status: 404 });
    await expect(store.update(ADMIN, "missing", "body")).rejects.toMatchObject({ status: 404 });
  });
});

describe("AdminService 受管提示词兼容层", () => {
  let root: string;
  let paths: DataPaths;
  let audit: AuditService;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "iw-prompts-admin-"));
    paths = resolveDataPaths(root);
    audit = new AuditService(paths);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("listPrompts 保持 web 既有只读列表形状", async () => {
    const admin = new AdminService(paths, audit, UNCONFIGURED, [], new UserStore(paths), new PromptStore(paths, audit));

    const prompts = await admin.listPrompts();

    expect(prompts.map((p) => p.id).sort()).toEqual(promptIds().sort());
    expect(Object.keys(prompts[0]!).sort()).toEqual(["description", "id", "name", "role"]);
  });

  it("updatePrompt 通过 actor.id 写入审计", async () => {
    const admin = new AdminService(paths, audit, UNCONFIGURED, [], new UserStore(paths), new PromptStore(paths, audit));

    await admin.updatePrompt(ADMIN, "element-extract", "admin edited prompt");

    await expect(admin.getPrompt("element-extract")).resolves.toMatchObject({ body: "admin edited prompt", isDefault: false });
    expect((await audit.readAll())[0]).toMatchObject({ user: ADMIN.id, action: "prompt.update" });
  });
});

describe("PromptStore 接入问答与要素服务", () => {
  let root: string;
  let paths: DataPaths;
  let audit: AuditService;
  let cases: CaseService;
  let materials: MaterialService;
  let store: PromptStore;
  let savedMode: string | undefined;

  beforeEach(async () => {
    savedMode = process.env.MINI_AGENT_INQUIRY_MODE;
    process.env.MINI_AGENT_INQUIRY_MODE = "single";
    root = await mkdtemp(path.join(tmpdir(), "iw-prompts-svc-"));
    paths = resolveDataPaths(root);
    audit = new AuditService(paths);
    cases = new CaseService(paths, audit, false);
    materials = new MaterialService(paths, audit, cases);
    store = new PromptStore(paths, audit);
  });

  afterEach(async () => {
    if (savedMode === undefined) delete process.env.MINI_AGENT_INQUIRY_MODE;
    else process.env.MINI_AGENT_INQUIRY_MODE = savedMode;
    await rm(root, { recursive: true, force: true });
  });

  async function createCase(content: string): Promise<{ caseId: string; chunk: Chunk }> {
    const caseId = (await cases.create(OPERATOR, { name: "提示词专题", clearance: "internal" })).id;
    await materials.ingest(OPERATOR, caseId, [{ filename: "intel.txt", content }]);
    const chunk = (await materials.loadCaseChunks(caseId))[0]!;
    return { caseId, chunk };
  }

  function llm(adapter: ModelAdapter) {
    return { adapter, guard: new OfflineGuard(["stub.local"], audit), modelEndpoint: ENDPOINT };
  }

  it("未编辑时带 store 与不带 store 的问答/要素输出等价，且默认 systemPrompt 不变", async () => {
    const { caseId, chunk } = await createCase("舰船线索：南海周边发现可疑舰船活动。代号 Siberia_01 在莫斯科活动。");

    const elementJson = () => JSON.stringify({
      elements: [{ name: "Siberia_01", type: "person", aliases: ["代号S"], mentions: [{ chunk_id: chunk.chunk_id }] }],
    });
    const elementInputsA: GenerateInput[] = [];
    const elementInputsB: GenerateInput[] = [];
    const elementsA = await new ElementService(paths, audit, cases, materials, llm(adapterReturning(elementJson, elementInputsA)))
      .extract(OPERATOR, caseId);
    const elementsB = await new ElementService(paths, audit, cases, materials, llm(adapterReturning(elementJson, elementInputsB)), store)
      .extract(OPERATOR, caseId);
    expect(elementsA.map(stripElement)).toEqual(elementsB.map(stripElement));
    expect(elementInputsA[0]?.systemPrompt).toBe(EXPECTED_DEFAULTS["element-extract"]);
    expect(elementInputsB[0]?.systemPrompt).toBe(elementInputsA[0]?.systemPrompt);

    const inquiryJson = () => JSON.stringify({
      claims: [{ text: "发现可疑舰船活动", type: "fact", citations: [chunk.chunk_id] }],
      insufficient: false,
    });
    const inquiryInputsA: GenerateInput[] = [];
    const inquiryInputsB: GenerateInput[] = [];
    const inquiryA = await new InquiryService(paths, audit, cases, materials, llm(adapterReturning(inquiryJson, inquiryInputsA)))
      .ask(OPERATOR, caseId, "舰船活动");
    const inquiryB = await new InquiryService(paths, audit, cases, materials, llm(adapterReturning(inquiryJson, inquiryInputsB)), undefined, undefined, undefined, undefined, store)
      .ask(OPERATOR, caseId, "舰船活动");
    expect(stripInquiry(inquiryA)).toEqual(stripInquiry(inquiryB));
    expect(inquiryInputsA[0]?.systemPrompt).toBe(EXPECTED_DEFAULTS["inquiry-structured"]);
    expect(inquiryInputsB[0]?.systemPrompt).toBe(inquiryInputsA[0]?.systemPrompt);
  });

  it("编辑后结构化问答与要素抽取使用 store 中的 systemPrompt", async () => {
    const { caseId, chunk } = await createCase("舰船线索：南海周边发现可疑舰船活动。代号 Siberia_01 在莫斯科活动。");
    await store.update(ADMIN, "element-extract", "CUSTOM ELEMENT SYSTEM PROMPT");
    await store.update(ADMIN, "inquiry-structured", "CUSTOM INQUIRY SYSTEM PROMPT");

    const elementInputs: GenerateInput[] = [];
    await new ElementService(
      paths,
      audit,
      cases,
      materials,
      llm(adapterReturning(() => JSON.stringify({ elements: [{ name: "Siberia_01", type: "person", mentions: [{ chunk_id: chunk.chunk_id }] }] }), elementInputs)),
      store,
    ).extract(OPERATOR, caseId);
    expect(elementInputs[0]?.systemPrompt).toBe("CUSTOM ELEMENT SYSTEM PROMPT");

    const inquiryInputs: GenerateInput[] = [];
    await new InquiryService(
      paths,
      audit,
      cases,
      materials,
      llm(adapterReturning(() => JSON.stringify({ claims: [{ text: "发现可疑舰船活动", type: "fact", citations: [chunk.chunk_id] }] }), inquiryInputs)),
      undefined,
      undefined,
      undefined,
      undefined,
      store,
    ).ask(OPERATOR, caseId, "舰船活动");
    expect(inquiryInputs[0]?.systemPrompt).toBe("CUSTOM INQUIRY SYSTEM PROMPT");
  });

  it("编辑 inquiry-methodology 后新建 inquiry agent 写入 AGENTS.md", async () => {
    await store.update(ADMIN, "inquiry-methodology", "CUSTOM AGENT METHODOLOGY");
    const agentRoot = path.join(root, ".agent-scratch-custom");
    const service = new InquiryService(
      paths,
      audit,
      cases,
      materials,
      llm(adapterReturning(() => "{}", [])),
      undefined,
      undefined,
      { agentWorkspaceRoot: agentRoot, runtimeVersion: "test", modelName: "stub", providerName: "scripted" },
      undefined,
      store,
    );

    await (service as unknown as { getInquiryAgent(): Promise<unknown> }).getInquiryAgent();

    expect(await readFile(path.join(agentRoot, "AGENTS.md"), "utf8")).toBe("CUSTOM AGENT METHODOLOGY\n");
  });
});
