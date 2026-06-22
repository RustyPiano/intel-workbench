import type { Element } from "../domain/types.js";
import { sha256 } from "../util/hash.js";

function normName(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

interface MergeBucket {
  key: string;
  type: Element["type"];
  aliases: string[];
  aliasKeys: Set<string>;
  mentions: Element["mentions"];
  mentionKeys: Set<string>;
  surfaces: Map<string, { count: number; firstSeen: number }>;
}

export function mergeElements(groups: Element[][]): Element[] {
  const buckets = new Map<string, MergeBucket>();
  let seen = 0;

  for (const group of groups) {
    for (const element of group) {
      const normalizedName = normName(element.name);
      const key = `${element.type} ${normalizedName}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = {
          key,
          type: element.type,
          aliases: [],
          aliasKeys: new Set(),
          mentions: [],
          mentionKeys: new Set(),
          surfaces: new Map(),
        };
        buckets.set(key, bucket);
      }

      const surface = bucket.surfaces.get(element.name);
      if (surface) {
        surface.count += 1;
      } else {
        bucket.surfaces.set(element.name, { count: 1, firstSeen: seen });
      }
      seen += 1;

      for (const alias of element.aliases) {
        if (!bucket.aliasKeys.has(alias)) {
          bucket.aliasKeys.add(alias);
          bucket.aliases.push(alias);
        }
      }

      for (const mention of element.mentions) {
        const mentionKey = `${mention.content_hash}${JSON.stringify(mention.locator)}`;
        if (!bucket.mentionKeys.has(mentionKey)) {
          bucket.mentionKeys.add(mentionKey);
          bucket.mentions.push(mention);
        }
      }
    }
  }

  const merged: Element[] = [];
  for (const bucket of buckets.values()) {
    if (bucket.mentions.length === 0) continue;

    let name = "";
    let bestCount = -1;
    let bestFirstSeen = Number.POSITIVE_INFINITY;
    for (const [surface, stats] of bucket.surfaces) {
      if (stats.count > bestCount || (stats.count === bestCount && stats.firstSeen < bestFirstSeen)) {
        name = surface;
        bestCount = stats.count;
        bestFirstSeen = stats.firstSeen;
      }
    }

    const normalizedName = normName(name);
    merged.push({
      id: `el-${sha256(bucket.key).slice(0, 8)}`,
      type: bucket.type,
      name,
      aliases: bucket.aliases.filter((alias) => normName(alias) !== normalizedName),
      mentions: bucket.mentions,
      freq: bucket.mentions.length,
    });
  }

  return merged.sort((a, b) => b.freq - a.freq || a.name.localeCompare(b.name) || a.type.localeCompare(b.type));
}
