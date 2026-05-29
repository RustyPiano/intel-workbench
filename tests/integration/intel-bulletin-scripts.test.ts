import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];
const SCRIPT_DIR = path.join(process.cwd(), ".agents", "skills", "intel-bulletin", "scripts");

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.allSettled(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "mini-agent-ib-scripts-"));
  tempRoots.push(root);
  return root;
}

function py(script: string, args: string[], cwd: string) {
  return execFileAsync("python3", [path.join(SCRIPT_DIR, script), ...args], { cwd });
}

describe("intel-bulletin scripts", () => {
  test("ingest.py extracts text from a DOCX using only the standard library", async () => {
    const workspace = await createWorkspace();
    // Build a minimal valid .docx (a zip with word/document.xml) via python.
    await execFileAsync(
      "python3",
      [
        "-c",
        [
          "import zipfile,sys",
          "doc='<?xml version=\"1.0\"?><w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body>'",
          "doc+='<w:p><w:r><w:t>下次检查点为4月20日。</w:t></w:r></w:p>'",
          "doc+='<w:p><w:r><w:t>需关注预算执行。</w:t></w:r></w:p></w:body></w:document>'",
          "z=zipfile.ZipFile(sys.argv[1],'w'); z.writestr('word/document.xml',doc); z.close()",
        ].join("\n"),
        path.join(workspace, "note.docx"),
      ],
    );

    const { stdout } = await py("ingest.py", ["note.docx"], workspace);
    expect(stdout).toContain("下次检查点为4月20日。");
    expect(stdout).toContain("需关注预算执行。");
  });

  test("manage_task.py supports add/remove/delete (CRUD)", async () => {
    const workspace = await createWorkspace();
    await writeFile(path.join(workspace, "a.md"), "alpha", "utf8");
    await writeFile(path.join(workspace, "b.md"), "beta", "utf8");

    await py("manage_task.py", ["create", "t1", "--title", "Task One"], workspace);
    await py("manage_task.py", ["add-source", "t1", "a.md"], workspace);
    await py("manage_task.py", ["add-source", "t1", "b.md"], workspace);

    const removed = await py("manage_task.py", ["remove-source", "t1", "b.md"], workspace);
    const manifest = JSON.parse(removed.stdout) as { sources: Array<{ name: string }> };
    expect(manifest.sources.map((s) => s.name)).toEqual(["a.md"]);
    expect(existsSync(path.join(workspace, "tasks", "t1", "sources", "a.md"))).toBe(true);
    expect(existsSync(path.join(workspace, "tasks", "t1", "sources", "b.md"))).toBe(false);

    await py("manage_task.py", ["delete", "t1"], workspace);
    expect(existsSync(path.join(workspace, "tasks", "t1"))).toBe(false);

    const list = await py("manage_task.py", ["list"], workspace);
    expect(JSON.parse(list.stdout)).toEqual([]);
  });

  test("render_report.py renders the bundled fixture spec deterministically", async () => {
    const workspace = await createWorkspace();
    const specPath = path.join(process.cwd(), "fixtures", "intel-bulletin", "bulletin.spec.json");
    const expected = await readFile(path.join(process.cwd(), "fixtures", "intel-bulletin", "expected-report.md"), "utf8");

    await py("render_report.py", [specPath, path.join(workspace, "out")], workspace);
    const rendered = await readFile(path.join(workspace, "out.md"), "utf8");
    expect(rendered).toBe(expected);
  });
});
