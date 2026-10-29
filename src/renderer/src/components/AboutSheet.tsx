import { useEffect, useRef, useState } from "react";
import type { AboutInfo } from "../../../shared/types";
import icon from "../assets/cubiq-icon.png";
import { api } from "../api";
import { useStore } from "../store";
import "../styles/about.css";

/**
 * The About CubiQ sheet: the app icon and version, the runtime versions, and
 * the git build stamp with a short changelog. Opened from the macOS app menu
 * (`open-about`) or Settings → Updates. `info` is a test seam for a static
 * render; the app passes nothing and the sheet fetches on open.
 */
export function AboutSheet({ info: initial }: { info?: AboutInfo | null } = {}) {
  const open = useStore((s) => s.aboutOpen);
  const setOpen = useStore((s) => s.setAboutOpen);
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

        <section>
          <h3>What's new</h3>
          {!info ? (
            <p className="about-empty">{failed ? "Couldn't read version info." : "Loading…"}</p>
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
          <button className="button primary" onClick={() => setOpen(false)}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
