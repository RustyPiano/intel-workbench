import type { RuntimeTool } from "mini-agent";
import { z } from "zod";

import type { Citation, Chunk, Identity } from "../domain/types.js";
import { resolveValidCitations } from "./citation.js";

export interface CitationLedger {
  retrieved: Map<string, Chunk>;
  cited: Map<string, Citation>;
  finalize: { claims: { text: string; cite_ids: string[] }[] } | null;
  readBytes: number;
}

export function createCitationLedger(): CitationLedger {
  return { retrieved: new Map(), cited: new Map(), finalize: null, readBytes: 0 };
}

export interface IntelToolDeps {
  ledger: CitationLedger;
  actor: Identity;
  caseId: string;
  nameById: Map<string, string>;
  retrieve: (query: string, k: number) => Promise<Chunk[]>;
  readBudgetBytes: number;
  perReadCapBytes: number;
}

function sliceByUtf8Bytes(text: string, maxBytes: number): { text: string; bytes: number } {
  let bytes = 0;
  let out = "";
  for (const char of text) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (bytes + charBytes > maxBytes) break;
    out += char;
    bytes += charBytes;
  }
  return { text: out, bytes };
}

export function createIntelTools(deps: IntelToolDeps): RuntimeTool[] {
  return [
    {
      name: "search_chunks",
      description: "检索本专题已加工片段；只回 id+摘要，需全文请用 read_chunk；只能引用检索到的片段。",
      inputSchema: z.object({
        query: z.string(),
        k: z.number().int().positive().max(20).optional(),
      }),
      async execute(args) {
        const parsed = args as { query: string; k?: number };
        const hits = await deps.retrieve(parsed.query, parsed.k ?? 6);
        for (const chunk of hits) deps.ledger.retrieved.set(chunk.chunk_id, chunk);
        return {
          ok: true,
          content: JSON.stringify(
            hits.map((chunk) => ({
              chunk_id: chunk.chunk_id,
              snippet: chunk.text.slice(0, 200),
              locator: chunk.locator,
              modality: chunk.modality,
              material_name: deps.nameById.get(chunk.material_id) ?? chunk.material_id,
            })),
          ),
        };
      },
    },
    {
      name: "read_chunk",
      description: "读取已由 search_chunks 检索到的片段全文；受本次问答读取预算限制，不能读取未检索片段。",
      inputSchema: z.object({ chunk_id: z.string() }),
      async execute(args) {
        const { chunk_id } = args as { chunk_id: string };
        const chunk = deps.ledger.retrieved.get(chunk_id);
        if (!chunk) return { ok: false, content: "未检索到该片段，请先 search_chunks" };
        if (deps.ledger.readBytes >= deps.readBudgetBytes) {
          return {
            ok: true,
            content: `读取预算已用尽（已读 ${deps.ledger.readBytes} 字节）。请基于已读内容调用 finalize_answer。`,
          };
        }
        const remaining = Math.max(0, deps.readBudgetBytes - deps.ledger.readBytes);
        const capped = sliceByUtf8Bytes(chunk.text, Math.min(deps.perReadCapBytes, remaining));
        deps.ledger.readBytes += capped.bytes;
        return { ok: true, content: capped.text };
      },
    },
    {
      name: "cite",
      description: "为一条结论绑定已检索片段；只有检索过且 sha256(text) 与 content_hash 一致的片段才会进入溯源台账。",
      inputSchema: z.object({ chunk_id: z.string(), claim: z.string() }),
      async execute(args) {
        // claim 用于 tool.cite 审计和促使模型明示推理，ledger 仅按 chunk_id 记账，finalize 时由 cite_ids 重建绑定。
        const { chunk_id } = args as { chunk_id: string; claim: string };
        const citations = resolveValidCitations([chunk_id], deps.ledger.retrieved, deps.nameById);
        if (citations.length === 1) {
          deps.ledger.cited.set(chunk_id, citations[0]!);
          return { ok: true, content: `已为该结论接地引用 ${chunk_id}` };
        }
        return {
          ok: false,
          content: "引用无效：该片段未检索到或内容哈希不一致（可能被篡改），请换证据。",
        };
      },
    },
    {
      name: "finalize_answer",
      description:
        "最终结论唯一入口，整次问答只调一次；每条 claim 的 cite_ids 必须是你已 cite 过的 chunk_id。最终答案只从这里 + 已接地引用生成，未在此处的内容一律丢弃。",
      inputSchema: z.object({
        claims: z.array(z.object({ text: z.string(), cite_ids: z.array(z.string()) }).strict()),
      }),
      async execute(args) {
        const { claims } = args as { claims: { text: string; cite_ids: string[] }[] };
        deps.ledger.finalize = { claims };
        return { ok: true, content: "已提交最终结论。" };
      },
    },
  ];
}
