import { execFile } from "node:child_process";
import { promisify } from "node:util";

export interface DocPage {
  page: number;
  text: string;
}

export interface DocParseResult {
  pages: DocPage[];
  engine: string;
}

export interface DocParser {
  parse(filePath: string): Promise<DocParseResult>;
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

export class LitDocParser implements DocParser {
  private readonly bin = process.env.MINI_AGENT_LIT_BIN ?? "lit";
  private readonly maxPages = parseMaxPages(process.env.MINI_AGENT_DOC_MAX_PAGES);

  buildArgs(filePath: string): string[] {
    return ["parse", "--format", "json", "--no-ocr", "--max-pages", String(this.maxPages), filePath];
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

    let json: unknown;
    try {
      json = JSON.parse(String(stdout));
    } catch (error) {
      throw new Error(`lit parse 输出不是有效 JSON：${errorMessage(error)}`);
    }

    const pages = (json as { pages?: unknown }).pages;
    if (!Array.isArray(pages)) throw new Error("lit parse 输出缺少 pages 数组");
    return {
      pages: pages.map((p) => {
        const page = p as { page?: unknown; text?: unknown };
        return { page: Number(page.page), text: String(page.text ?? "") };
      }),
      engine: "liteparse",
    };
  }
}
