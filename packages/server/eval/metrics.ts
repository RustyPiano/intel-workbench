export interface QueryRanking {
  ranked: string[];
  relevant: string[] | Set<string>;
}

export type MetricAverages = Record<string, number>;

function relevantSet(relevant: string[] | Set<string>): Set<string> {
  return relevant instanceof Set ? relevant : new Set(relevant);
}

function topK(ranked: string[], k: number): string[] {
  return k > 0 ? ranked.slice(0, k) : [];
}

export function recallAtK(ranked: string[], relevant: string[] | Set<string>, k: number): number {
  const gold = relevantSet(relevant);
  if (gold.size === 0) return 0;
  let hits = 0;
  for (const id of new Set(topK(ranked, k))) {
    if (gold.has(id)) hits++;
  }
  return hits / gold.size;
}

export function mrrAtK(ranked: string[], relevant: string[] | Set<string>, k: number): number {
  const gold = relevantSet(relevant);
  if (gold.size === 0) return 0;
  const limit = Math.min(Math.max(k, 0), ranked.length);
  for (let i = 0; i < limit; i++) {
    if (gold.has(ranked[i])) return 1 / (i + 1);
  }
  return 0;
}

function dcgAtK(ranked: string[], relevant: Set<string>, k: number): number {
  let sum = 0;
  const limit = Math.min(Math.max(k, 0), ranked.length);
  const counted = new Set<string>();
  for (let i = 0; i < limit; i++) {
    const id = ranked[i];
    // 每个相关 id 至多计一次（与 recallAtK 的 topK 去重一致），避免重复 id 使 nDCG>1。
    if (relevant.has(id) && !counted.has(id)) {
      counted.add(id);
      sum += 1 / Math.log2(i + 2);
    }
  }
  return sum;
}

export function ndcgAtK(ranked: string[], relevant: string[] | Set<string>, k: number): number {
  const gold = relevantSet(relevant);
  if (gold.size === 0 || k <= 0) return 0;
  const idealHits = Math.min(gold.size, k);
  let idcg = 0;
  for (let i = 0; i < idealHits; i++) {
    idcg += 1 / Math.log2(i + 2);
  }
  return idcg === 0 ? 0 : dcgAtK(ranked, gold, k) / idcg;
}

export function aggregateMetrics(rows: QueryRanking[], ks: number[]): MetricAverages {
  const out: MetricAverages = {};
  const denom = rows.length || 1;
  for (const k of ks) {
    out[`recallAt${k}`] = rows.reduce((sum, r) => sum + recallAtK(r.ranked, r.relevant, k), 0) / denom;
    out[`mrrAt${k}`] = rows.reduce((sum, r) => sum + mrrAtK(r.ranked, r.relevant, k), 0) / denom;
    out[`ndcgAt${k}`] = rows.reduce((sum, r) => sum + ndcgAtK(r.ranked, r.relevant, k), 0) / denom;
  }
  return out;
}
