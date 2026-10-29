import { useCallback, useEffect, useState } from "react";
import type { DoctorFinding, DoctorFix, DoctorFixResult, DoctorReport } from "../../../shared/doctor";
import { api } from "../api";
import { useStore } from "../store";

/** The Doctor report as the sheet draws it: summary, groups, and one row per fix. */
export function DoctorReportView({
  report,
  running,
  results,
  onFix,
  onCopy,
  onRecheck,
  confirming,
  onConfirm,
  onCancel,
}: {
  report: DoctorReport | null;
  running: boolean;
  results: Record<string, DoctorFixResult>;
  onFix: (findingId: string, fixIndex: number, fix: DoctorFix) => void;
  onCopy: (text: string) => void;
  onRecheck: () => void;
  /** The `${findingId}:${fixIndex}` whose run command is waiting for a yes. */
  confirming: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const groups: { key: DoctorFinding["group"]; label: string }[] = [
    { key: "agents", label: "Agents" },
    { key: "environment", label: "Environment" },
    { key: "worktrees", label: "Worktrees" },
  ];
  const order: Record<DoctorFinding["level"], number> = { error: 0, warn: 1, ok: 2 };

  return (
    <>
      <p className="doctor-summary">{summary(report, running)}</p>
      <button className="button ghost" disabled={running} onClick={onRecheck}>
        Check again
      </button>
      {report &&
        groups.map(({ key, label }) => {
          const findings = report.findings
            .map((finding, index) => ({ finding, index }))
            .filter(({ finding }) => finding.group === key)
            .sort((a, b) => order[a.finding.level] - order[b.finding.level] || a.index - b.index)
            .map(({ finding }) => finding);
          if (findings.length === 0) return null;
          return (
            <section key={key}>
              <h3>{label}</h3>
              {findings.map((finding) => (
                <FindingRow
                  key={finding.id}
                  finding={finding}
                  results={results}
                  confirming={confirming}
                  onFix={onFix}
                  onCopy={onCopy}
                  onConfirm={onConfirm}
                  onCancel={onCancel}
                />
              ))}
            </section>
          );
        })}
    </>
  );
}

function FindingRow({
  finding,
  results,
  confirming,
  onFix,
  onCopy,
  onConfirm,
  onCancel,
}: {
  finding: DoctorFinding;
  results: Record<string, DoctorFixResult>;
  confirming: string | null;
  onFix: (findingId: string, fixIndex: number, fix: DoctorFix) => void;
  onCopy: (text: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const level = finding.level;
  const levelLabel = level === "ok" ? "OK" : level === "warn" ? "Warning" : "Problem";
  return (
    <div className={`doctor-finding ${level}`}>
      <span className="doctor-dot" aria-label={levelLabel} role="img" />
      <span className="doctor-title">{finding.title}</span>
      {level !== "ok" && finding.detail && <pre className="doctor-detail">{finding.detail}</pre>}
      {level !== "ok" && finding.fixes.length > 0 && (
        <div className="doctor-fixes">
          {finding.fixes.map((fix, index) => {
            const key = `${finding.id}:${index}`;
            const result = results[key];
            const line = fix.kind === "run" ? [fix.command, ...fix.args].join(" ") : "";
            if (confirming === key && fix.kind === "run") {
              return (
                <span className="doctor-confirm" key={key}>
                  <span>
                    Run <code>{line}</code>?
                  </span>
                  <button className="button" onClick={onConfirm}>
                    Run
                  </button>
                  <button className="button ghost" onClick={onCancel}>
                    Cancel
                  </button>
                </span>
              );
            }
            return (
              <span className="doctor-fix" key={key}>
                {fix.kind === "copy" ? (
                  <>
                    <button className="button ghost" onClick={() => onCopy(fix.text)}>
                      {fix.label}
                    </button>
                    <code>{fix.text}</code>
                  </>
                ) : (
                  <>
                    <button className="button" onClick={() => onFix(finding.id, index, fix)}>
                      {fix.label}
                    </button>
                    {fix.kind === "run" && <code>{line}</code>}
                  </>
                )}
                {result && <span className={`doctor-result ${result.ok ? "ok" : "error"}`}>{result.message}</span>}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

function summary(report: DoctorReport | null, running: boolean): string {
  if (!report) return running ? "Checking…" : "Not checked yet";
  const problems = report.findings.filter((finding) => finding.level === "error").length;
  const warnings = report.findings.filter((finding) => finding.level === "warn").length;
  const count = [
    problems > 0 ? `${problems} problem${problems === 1 ? "" : "s"}` : "",
    warnings > 0 ? `${warnings} warning${warnings === 1 ? "" : "s"}` : "",
  ]
    .filter(Boolean)
    .join(", ");
  const d = new Date(report.at);
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `${count || "Everything looks fine"} · checked ${time}`;
}

/** The /doctor sheet: every agent install, the environment and leftover worktrees, each fix a click away. */
export function DoctorSheet() {
  const open = useStore((s) => s.doctorOpen);
  const close = useStore((s) => s.closeDoctor);
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<Record<string, DoctorFixResult>>({});
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const check = useCallback(() => {
    setRunning(true);
    setError(null);
    void api()
      .runDoctor()
      .then(setReport)
      .catch((err) => setError(errorText(err)))
      .finally(() => setRunning(false));
  }, []);

  useEffect(() => {
    if (!open) return;
    setResults({});
    setConfirming(null);
    check();
  }, [open, check]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  const applyFix = async (findingId: string, fixIndex: number) => {
    setConfirming(null);
    try {
      const result = await api().doctorFix(findingId, fixIndex);
      setResults((r) => ({ ...r, [`${findingId}:${fixIndex}`]: result }));
      if (result.ok) check();
    } catch (err) {
      setResults((r) => ({ ...r, [`${findingId}:${fixIndex}`]: { ok: false, message: errorText(err) } }));
    }
  };

  const fix = (findingId: string, fixIndex: number, item: DoctorFix) => {
    if (item.kind === "run") {
      setConfirming(`${findingId}:${fixIndex}`);
      return;
    }
    void applyFix(findingId, fixIndex);
  };

  const confirm = () => {
    if (!confirming) return;
    const at = confirming.lastIndexOf(":");
    void applyFix(confirming.slice(0, at), Number(confirming.slice(at + 1)));
  };

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text);
    const keys: string[] = [];
    for (const finding of report?.findings ?? []) {
      finding.fixes.forEach((item, index) => {
        if (item.kind === "copy" && item.text === text) keys.push(`${finding.id}:${index}`);
      });
    }
    if (keys.length) {
      const copied: Record<string, DoctorFixResult> = {};
      for (const key of keys) copied[key] = { ok: true, message: "Copied" };
      setResults((r) => ({ ...r, ...copied }));
    }
  };

  if (!open) return null;
  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="sheet doctor-sheet" role="dialog" aria-modal="true" aria-label="Doctor">
        <div className="sheet-head">
          <h2>Doctor</h2>
          <button className="button ghost" onClick={close}>
            Done
          </button>
        </div>
        {error && <p className="doctor-error">{error}</p>}
        <DoctorReportView
          report={report}
          running={running}
          results={results}
          onFix={fix}
          onCopy={copy}
          onRecheck={check}
          confirming={confirming}
          onConfirm={confirm}
          onCancel={() => setConfirming(null)}
        />
      </div>
    </div>
  );
}

function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}
