import { useEffect, useMemo, useState } from "react";
import { RotateCw } from "lucide-react";
import type { AppInfo } from "../../../shared/types";
import { api } from "../api";
import { useStore } from "../store";
import { AppFrame, appIcon } from "./AppFrame";

interface CardState {
  app: AppInfo | null;
  loading: boolean;
  error: string | null;
}

/** Stored results resolve a declared local surface again, never a URL from history. */
export function PluginChatCard({ pluginKey, name, data, threadId }: { pluginKey: string; name: string; data: unknown; threadId: string }) {
  const apps = useStore((s) => s.apps);
  const changes = useStore((s) => s.appReloads[pluginKey] ?? 0);
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<CardState>({ app: null, loading: true, error: null });
  const card = useMemo(() => ({ threadId, data }), [threadId, data]);
  useEffect(() => {
    let gone = false;
    setState({ app: null, loading: true, error: null });
    void api().appCardInfo(pluginKey, name, threadId).then((app) => {
      if (!gone) setState({ app, loading: false, error: app ? null : "This plugin card is unavailable. It may be Off or uninstalled." });
    }).catch(() => { if (!gone) setState({ app: null, loading: false, error: "Couldn't load this plugin card." }); });
    return () => { gone = true; };
  }, [pluginKey, name, threadId, apps, changes, retry]);
  return <PluginChatCardView {...state} card={card} onRetry={() => setRetry((n) => n + 1)} />;
}

/** Pure view seam for loading/unavailable states and the sandbox contract. Retry never invokes an agent tool. */
export function PluginChatCardView({ app, loading, error, card, onRetry }: CardState & { card: { threadId: string; data: unknown }; onRetry(): void }) {
  const Icon = appIcon(app?.icon);
  return (
    <section className="plugin-chat-card" style={app ? { height: (app.height ?? 200) + 36 } : undefined} aria-label={app ? `${app.title} result` : "Plugin result"}>
      {app ? <AppFrame app={app} card={card} head={({ logsButton, reload }) => <header className="plugin-chat-card-head">
        <Icon size={14} aria-hidden="true" /><span>{app.title}</span>{logsButton}
        <button type="button" className="icon-button" aria-label={`Reload ${app.title} card`} onClick={reload}><RotateCw size={14} /></button>
      </header>} /> : <div className="plugin-chat-card-state" role={error ? "status" : undefined}>
        <span>{loading ? "Loading plugin result…" : error}</span>
        {!loading && <button type="button" className="button ghost" onClick={onRetry}>Retry</button>}
      </div>}
    </section>
  );
}
