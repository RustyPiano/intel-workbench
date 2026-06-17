/**
 * 文档解析适配器（intel-p3.doc）。注入式 DocParser + 本地 liteparse(`lit`) 实现。
 *
 * 信任边界（红线说明，勿删）：`lit` 是对**本地文件**的**本地子进程**解析，与媒体管线
 * shell 调 ffmpeg 同属"本地计算"信任类别，故**有意不经 OfflineGuard**——OfflineGuard
 * 只授权模型端点出站；本解析器在我们给定的参数下（`--no-ocr`，且**绝不传** `--ocr-server-url`）
 * 无任何联网代码路径，零外发由 OS/部署层气隙保证。**永远不要给 `lit` 加网络参数。**
 */
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

export interface DocPage {
  page: number;
  text: string;
}

export interface DocParseResult {
  pages: DocPage[];
  engine: string;
}

export interface DocPageImage {
  page: number;
  image: Buffer;
}

export interface DocParser {
  parse(filePath: string): Promise<DocParseResult>;
  rasterize(filePath: string): Promise<DocPageImage[]>;
}

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_PAGES = 1000;
const TIMEOUT_MS = 120_000;
const MAX_BUFFER = 256 * 1024 * 1024;

function parseMaxPages(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_PAGES;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * 解析 `lit --format json` 的 stdout → 规范化 pages。纯函数（无 IO），供单测覆盖
 * 错误形态与页号兜底。页号缺失/非有限/非正 → 回落为顺序页码（1 基），杜绝 NaN
 * 经 JSON.stringify 落成 `"page":null` 的脏定位（评审 MAJOR：done 素材却带 null 页码）。
 */
export function parseLitJson(stdout: string): DocParseResult {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`lit parse 输出不是有效 JSON：${errorMessage(error)}`);
  }
  const pages = (json as { pages?: unknown }).pages;
  if (!Array.isArray(pages)) throw new Error("lit parse 输出缺少 pages 数组");
  return {
    pages: pages.map((p, idx) => {
      const rec = p as { page?: unknown; text?: unknown };
      const n = Number(rec.page);
      return { page: Number.isFinite(n) && n > 0 ? Math.trunc(n) : idx + 1, text: String(rec.text ?? "") };
    }),
    engine: "liteparse",
  };
}

export class LitDocParser implements DocParser {
  private readonly bin = process.env.MINI_AGENT_LIT_BIN ?? "lit";
  private readonly maxPages = parseMaxPages(process.env.MINI_AGENT_DOC_MAX_PAGES);

  buildArgs(filePath: string): string[] {
    return ["parse", "--format", "json", "--no-ocr", "--max-pages", String(this.maxPages), filePath];
  }

  buildScreenshotArgs(filePath: string, outDir: string): string[] {
    return ["screenshot", "--dpi", "150", "-o", outDir, filePath];
  }

  async parse(filePath: string): Promise<DocParseResult> {
    let stdout: string | Buffer;
    try {
      ({ stdout } = await execFileAsync(this.bin, this.buildArgs(filePath), {
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
      }));
    } catch (error) {
      throw new Error(`lit parse 失败：${errorMessage(error)}`);
    }
    return parseLitJson(String(stdout));
  }

  async rasterize(filePath: string): Promise<DocPageImage[]> {
    const dir = await mkdtemp(path.join(tmpdir(), "iw-lit-pages-"));
    try {
      await execFileAsync(this.bin, this.buildScreenshotArgs(filePath, dir), {
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
      });
      const files = await readdir(dir);
      const pages = files
        .map((name) => {
          const m = /^page_(\d+)\.png$/i.exec(name);
          return m ? { page: Number.parseInt(m[1], 10), name } : null;
        })
        .filter((p): p is { page: number; name: string } => p !== null && Number.isFinite(p.page) && p.page > 0)
        .sort((a, b) => a.page - b.page);
      const out: DocPageImage[] = [];
      for (const page of pages) {
        out.push({ page: page.page, image: await readFile(path.join(dir, page.name)) });
      }
      return out;
    } catch (error) {
      throw new Error(`lit screenshot 失败：${errorMessage(error)}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
