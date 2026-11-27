import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { resolveInside } from "../artifacts";
import { resolveRef } from "./inline";
import { listDesignPages } from "./pages";
import { APP_ALLOWED_EXTENSIONS, validateApp } from "../apps/manifest";

const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

/** Collect local page and stylesheet dependencies without rewriting the reviewed bytes. */
function references(rel: string, bytes: Buffer): string[] {
  if (!/\.(html?|css|svg)$/i.test(rel)) return [];
  const source = bytes.toString("utf8"), refs: string[] = [];
  for (const m of source.matchAll(/(?:url\(\s*|@import\s+(?!url\())(?:"([^"]+)"|'([^']+)'|([^'"\s)]+))/gi)) refs.push(m[1] ?? m[2] ?? m[3]!);
  if (!/\.css$/i.test(rel)) {
    for (const m of source.matchAll(/<[\w:-]+\b[^>]*>/g)) {
      for (const a of m[0].matchAll(/\s(src|srcset|href|poster|xlink:href)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi)) {
        const value = a[2] ?? a[3] ?? a[4]!;
        if (a[1]!.toLowerCase() === "srcset" && !value.includes("data:")) refs.push(...value.split(",").map((v) => v.trim().split(/\s/)[0]!));
        else refs.push(value);
      }
    }
  }
  return refs.filter((v) => !/^(?:#|\?|[a-z][a-z\d+.-]*:|\/\/)/i.test(v)).map((ref) => {
    const path = resolveRef(rel, ref);
    if (!path) throw new Error(`${rel} references a file outside the design: ${ref}`);
    return path;
  });
}

export async function captureDesign(root: string, page: string, handoff: boolean) {
  const pages = listDesignPages(root);
  if (!pages.includes(page)) throw new Error(`Missing design page: ${page}`);
  const pending = new Set(handoff ? [...pages, "handoff.md"] : [page]);
  if (handoff) {
    if (existsSync(join(root, "comments.json"))) pending.add("comments.json");
    const walkKit = async (rel: string): Promise<void> => {
      for (const e of await readdir(join(root, rel), { withFileTypes: true })) {
        const path = `${rel}/${e.name}`;
        if (e.name.startsWith(".")) continue;
        if (e.isDirectory()) await walkKit(path);
        else pending.add(path);
      }
    };
    if (existsSync(join(root, "system"))) await walkKit("system");
  }
  const contents = new Map<string, Buffer>();
  const missing: string[] = [];
  for (const rel of pending) {
    const safe = resolveInside(root, rel);
    if (!safe) { missing.push(rel); continue; }
    const bytes = await readFile(join(root, safe)).catch(() => null);
    if (!bytes) { missing.push(rel); continue; }
    contents.set(rel, bytes);
    for (const ref of references(rel, bytes)) pending.add(ref);
  }
  if (missing.length) throw new Error(`Missing design inputs: ${missing.join(", ")}`);
  const files = [...contents.keys()].sort().map((path) => ({ path, sha256: hash(contents.get(path)!) }));
  return { contents, files, digest: hash(JSON.stringify([page, files])) };
}

/** The caller supplies a new, private directory. Snapshots never link back to editable source files. */
export async function writeDesignSnapshot(dir: string, files: Map<string, Buffer>): Promise<void> {
  for (const [rel, bytes] of files) {
    const path = join(dir, rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, { flag: "wx", mode: 0o444 });
  }
}

export async function creatorFilesFromReview(dir: string, review: import("../../shared/types").DesignReview, name: string, size: { width: number; height: number }) {
  const { contents } = await captureDesign(dir, review.page, false);
  const errors: string[] = [];
  const files: { path: string; content: string }[] = [];
  for (const [path, bytes] of contents) {
    if (!APP_ALLOWED_EXTENSIONS.has(extname(path).toLowerCase())) { errors.push(`Unsupported dependency: ${path}`); continue; }
    if (hash(bytes) !== review.files.find((f) => f.path === path)?.sha256) { errors.push(`Changed since approval: ${path}`); continue; }
    try { files.push({ path, content: new TextDecoder("utf-8", { fatal: true }).decode(bytes) }); }
    catch { errors.push(`Not UTF-8: ${path}`); }
  }
  if (errors.length) throw new Error(errors.join("\n"));
  files.push({ path: "app.json", content: JSON.stringify({ name, title: review.page, description: `From reviewed design ${review.digest}`, entry: review.page, placement: "floating", size, grants: [] }, null, 2) });
  files.push({ path: "design-source.md", content: `Source revision: ${review.digest}\nReviewed page: ${review.page}\n` });
  const result = validateApp(name, files);
  if (!result.ok) throw new Error(result.errors.join("\n"));
  return result.files;
}
