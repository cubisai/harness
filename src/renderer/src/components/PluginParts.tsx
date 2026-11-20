import type { PluginOwner, PluginPartView } from "../../../shared/plugin-parts";

export function PluginOwnerNote({ owner, onManage }: { owner?: PluginOwner; onManage(): void }) {
  if (!owner) return null;
  return <p className="note">Managed by {owner.title}{owner.enabled ? "" : " · Off or unavailable"}. Uninstall its plugin to remove this part. <button type="button" className="button ghost" onClick={onManage}>Manage plugin</button></p>;
}

/** The same compact, read-only disclosure on proposals and installed plugin details. */
export function PluginParts({ parts, installed = false }: { parts?: PluginPartView[]; installed?: boolean }) {
  if (!parts?.length) return null;
  return <section className="apps-library-grants">
    <h4>Bundled parts</h4>
    <p className="note">One reviewed plugin owns these parts. {installed ? "Turning it on starts no connector, sign-in or automation run." : "Installing starts no connector, sign-in or automation run."}</p>
    {parts.map((part) => <details className="proposal-preview-wrap" key={`${part.kind}:${part.name}`}>
      <summary className="proposal-preview-toggle" title={part.name} style={{ maxWidth: "100%", minWidth: 0 }}><code style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{part.name}</code><span>{part.kind}</span>{part.change && <span className={`proposal-change ${part.change}`}>{part.change === "added" ? "New" : part.change === "changed" ? "Changed" : "Removed"}</span>}</summary>
      <p className="note">{part.description}</p>
      {part.risk && <p className="form-error">Runs a local program on this computer. Only connect programs you trust.</p>}
      {part.kind === "automation" && <p className="note">Only in project {part.projectName ?? part.projectId ?? "unavailable"}. Saved Off/Ask; plugin On does not enable its schedule.</p>}
      {part.detail && <pre className="tool-pre">{part.detail}</pre>}
    </details>)}
  </section>;
}
