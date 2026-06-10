import type { Chunk, Citation } from "../domain/types.js";
import { sha256 } from "../util/hash.js";

/**
 * Citation 共享逻辑（工程方案 §4.3 / §7.3 step 4）。被问答与要素抽取复用：
 * 把模型给出的 chunk_id 解析为对外 Citation，且仅当该 chunk 命中本次检索集、
 * 其 content_hash 与当前素材一致时才有效（杜绝凭空捏造 / 素材变更后失效）。
 */

export function chunkToCitation(chunk: Chunk, materialName: string, confidence = 0.6): Citation {
  return {
    material_id: chunk.material_id,
    material_name: materialName,
    // 透传 chunk 自带模态/出处（二期 Spec §2.2）；旧 chunk 无 modality 字段时缺省 "doc"。
    modality: chunk.modality ?? "doc",
    locator: chunk.locator,
    snippet: chunk.text.slice(0, 200),
    confidence,
    content_hash: chunk.content_hash,
  };
}

/** 解析候选 chunk_id 列表为有效 Citation（丢弃不存在或 hash 不一致的）。 */
export function resolveValidCitations(
  ids: readonly string[],
  retrievedById: Map<string, Chunk>,
  nameById: Map<string, string>,
): Citation[] {
  const citations: Citation[] = [];
  for (const id of ids) {
    const chunk = retrievedById.get(id);
    if (!chunk || sha256(chunk.text) !== chunk.content_hash) continue;
    citations.push(chunkToCitation(chunk, nameById.get(chunk.material_id) ?? chunk.material_id));
  }
  return citations;
}
