import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DesignSystemInfo } from "../design/systems";
import type { StoredProposal } from "../extensions/manifest";
import { assertContained } from "../extensions/install";
import { readThemeFiles } from "./themes";

/** Private, script-free specimens. A proposal ID is an identity, never a model-supplied filesystem path. */
export class ThemePreviews {
  private ready = new Map<string, string>();
  constructor(private deps: {
    dir: string;
    proposal(id: string): StoredProposal | null;
    resolve(projectId: string, base: string): DesignSystemInfo | null;
  }) {}

  system(projectId: string | null, id: string): DesignSystemInfo | null {
    if (!/^creator:[a-zA-Z0-9-]{1,80}$/.test(id)) return null;
    const p = this.deps.proposal(id.slice(8));
    if (!p || p.scope.kind !== "project" || p.scope.projectId !== projectId || p.draft.kind !== "theme" || p.status === "rejected") return null;
    try {
      const files = readThemeFiles(p.draft, (base) => this.deps.resolve(p.scope.kind === "project" ? p.scope.projectId : "", base));
      const dir = join(this.deps.dir, p.id);
      if (this.ready.get(p.id) !== p.digest) {
        mkdirSync(this.deps.dir, { recursive: true });
        if (lstatSync(this.deps.dir).isSymbolicLink()) throw new Error("Preview root is a symlink.");
        assertContained(this.deps.dir, dir);
        mkdirSync(dir, { recursive: true });
        if (lstatSync(dir).isSymbolicLink()) throw new Error("Preview is a symlink.");
        for (const f of files.filter((f) => f.path === "tokens.css" || f.path.startsWith("fonts/"))) {
          const target = join(dir, ...f.path.split("/"));
          assertContained(dir, target);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, f.content);
        }
        this.ready.set(p.id, p.digest);
      }
      return { id, name: p.draft.title, description: p.draft.description, swatches: [], source: "projectFolder", designMd: "", tokensCss: join(dir, "tokens.css"), fontFiles: files.filter((f) => f.path.startsWith("fonts/")).map((f) => join(dir, f.path)) };
    } catch {
      return null;
    }
  }
}
