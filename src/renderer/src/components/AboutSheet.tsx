import { useEffect, useRef, useState } from "react";
import type { AboutInfo } from "../../../shared/types";
import icon from "../assets/cubiq-icon.png";
import { api } from "../api";
import { useStore } from "../store";
import "../styles/about.css";

/**
 * The About CubiQ sheet: the app icon and version, the runtime versions, and
 * the release notes from CHANGELOG.md (the git build stamp's commits when a
 * build has none), and a downloaded update's notes with Restart. Opened from the macOS app menu
 * (`open-about`) or Settings → Updates. `info` is a test seam for a static
 * render; the app passes nothing and the sheet fetches on open.
 */
export function AboutSheet({ info: initial }: { info?: AboutInfo | null } = {}) {
  const open = useStore((s) => s.aboutOpen);
  const setOpen = useStore((s) => s.setAboutOpen);
  const update = useStore((s) => s.appUpdate);
  const [fetched, setFetched] = useState<AboutInfo | null>(null);
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const info = initial ?? fetched;

  useEffect(() => {
    if (!open || initial !== undefined) return;
    setCopied(false);
    setFailed(false);
    void api()
      .aboutInfo()
      .then(setFetched)
      .catch(() => {
        setFetched(null);
        setFailed(true);
      });
  }, [open, initial]);

  useEffect(() => () => {
    if (copyTimer.current !== null) clearTimeout(copyTimer.current);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, setOpen]);

  if (!open) return null;

  const copy = () => {
    if (!info) return;
    const text = `${info.name} ${info.version} (${info.commit ?? "dev"}, ${info.commitDate ?? "unknown"})\nElectron ${info.electron} · Chromium ${info.chrome} · Node ${info.node}\n${info.os}`;
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        if (copyTimer.current !== null) clearTimeout(copyTimer.current);
        copyTimer.current = setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };

  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className="sheet about-sheet" role="dialog" aria-modal="true" aria-label="About CubiQ">
        <div className="about-head">
          <img className="about-icon" src={icon} width={64} height={64} alt="" />
          <h2>{info?.name ?? "CubiQ"}</h2>
          {info && (
            <>
              <p className="about-version">Version {info.version}</p>
              <p className="about-commit">{info.commit ? `${info.commit} · ${info.commitDate ?? ""}` : "Development build"}</p>
              <p className="about-runtime">
                Electron {info.electron} · Chromium {info.chrome} · Node {info.node} · {info.os}
              </p>
            </>
          )}
        </div>

        {update?.ready && (
          <section>
            <h3>Ready to install · {update.ready}</h3>
            {update.notes ? <NotesText text={update.notes} /> : <p className="about-empty">This release has no notes.</p>}
          </section>
        )}

        <section>
          <h3>What's new</h3>
          {!info ? (
            <p className="about-empty">{failed ? "Couldn't read version info." : "Loading…"}</p>
          ) : info.releases?.length ? (
            <div className="about-releases">
              {info.releases.map((r) => (
                <div className="about-release" key={r.version}>
                  <p className="about-release-head">
                    <span className="about-release-version">{r.version}</span>
                    {r.date && <span className="about-date">{r.date}</span>}
                    {r.version === info.version && <span className="about-release-current">Installed</span>}
                  </p>
                  {r.groups.map((g) => (
                    <div key={g.title}>
                      <p className="about-group">{g.title}</p>
                      <ul className="about-notes">
                        {g.items.map((item, i) => (
                          <li key={i}>{item}</li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ) : info.changelog.length > 0 ? (
            <ul className="about-changelog">
              {info.changelog.map((row) => (
                <li key={`${row.hash}-${row.date}`}>
                  <span className="about-hash">{row.hash}</span>
                  <span className="about-date">{row.date}</span>
                  <span className="about-subject">{row.subject}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="about-empty">No changelog in this build.</p>
          )}
        </section>

        <div className="about-actions">
          <span className="spacer" />
          <button className="button" disabled={!info} onClick={copy}>
            {copied ? "Copied" : "Copy info"}
          </button>
          {update?.ready ? (
            <>
              <button className="button" onClick={() => setOpen(false)}>
                Later
              </button>
              <button className="button primary" onClick={() => void api().installUpdate()}>
                Restart to update
              </button>
            </>
          ) : (
            <button className="button primary" onClick={() => setOpen(false)}>
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Plain-text release notes: "- " lines are bullets, other lines group titles. */
function NotesText({ text }: { text: string }) {
  const blocks: { title: string | null; items: string[] }[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("- ")) {
      if (!blocks.length) blocks.push({ title: null, items: [] });
      blocks[blocks.length - 1]!.items.push(line.slice(2));
    } else blocks.push({ title: line, items: [] });
  }
  return (
    <div className="about-release">
      {blocks.map((b, i) => (
        <div key={i}>
          {b.title && <p className="about-group">{b.title}</p>}
          {b.items.length > 0 && (
            <ul className="about-notes">
              {b.items.map((item, j) => (
                <li key={j}>{item}</li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}
