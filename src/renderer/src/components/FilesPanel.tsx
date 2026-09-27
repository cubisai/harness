import { useEffect, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";

/** A node of the project's file tree: a directory has children, a file has a path to open. */
type TreeNode = { name: string; path: string; children?: TreeNode[] };

/** The project's files as a tree: directories first, then files, each alphabetical ignoring case. */
export function buildTree(files: string[]): TreeNode[] {
  const dirOf = (p: string) => {
    const i = p.lastIndexOf("/");
    return i < 0 ? "" : p.slice(0, i);
  };
  const nameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
  const dirs = new Set<string>();
  const byParent = new Map<string, string[]>();
  const add = (parent: string, child: string) => {
    const list = byParent.get(parent);
    if (list) list.push(child);
    else byParent.set(parent, [child]);
  };
  for (const file of files) {
    add(dirOf(file), file);
    for (let d = dirOf(file); d !== "" && !dirs.has(d); d = dirOf(d)) {
      dirs.add(d);
      add(dirOf(d), d);
    }
  }
  const byName = (a: string, b: string) => {
    const x = nameOf(a).toLowerCase();
    const y = nameOf(b).toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  };
  const list = (dir: string): TreeNode[] => {
    const entries = byParent.get(dir) ?? [];
    const inside = (isDir: boolean) => entries.filter((p) => dirs.has(p) === isDir).sort(byName);
    return [
      ...inside(true).map((d) => ({ name: nameOf(d), path: d, children: list(d) })),
      ...inside(false).map((f) => ({ name: nameOf(f), path: f })),
    ];
  };
  return list("");
}

/** The project's files; clicking one opens it at line 1 in the configured editor. */
export function FilesPanel({ projectId, refreshKey }: { projectId: string; refreshKey: number }) {
  const [result, setResult] = useState<{ files: string[]; truncated: boolean } | null>(null);
  useEffect(() => {
    void api()
      .listFiles(projectId)
      .then(setResult)
      .catch(() => setResult({ files: [], truncated: false }));
  }, [projectId, refreshKey]);

  if (result === null) return <div className="files-panel">Loading…</div>;
  if (result.files.length === 0) return <div className="files-panel">No files.</div>;
  return (
    <div className="files-panel">
      <TreeList nodes={buildTree(result.files)} depth={0} />
      {result.truncated && <div className="files-note">Showing the first {result.files.length} files.</div>}
    </div>
  );
}

function TreeList({ nodes, depth }: { nodes: TreeNode[]; depth: number }) {
  return (
    <>
      {nodes.map((n) =>
        n.children ? (
          <details key={n.path} open={depth === 0}>
            <summary>{n.name}</summary>
            <div>
              <TreeList nodes={n.children} depth={depth + 1} />
            </div>
          </details>
        ) : (
          <button key={n.path} className="file-node" title={n.path} onClick={() => void useStore.getState().openInEditor({ path: n.path, line: 1 })}>
            {n.name}
          </button>
        ),
      )}
    </>
  );
}
