import { Globe } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { LinkMeta } from "../../../shared/types";
import { useStore } from "../store";

/** The card's width (kept in step with .link-card), its window inset, and the hover delay. */
const CARD_W = 300;
const CARD_EDGE = 8;
/** First-pass height guess; the card is measured once it is in the DOM. */
const CARD_EST = 120;
const HOVER_DELAY = 300;

/** A URL's host without a leading "www.", or the raw URL when it doesn't parse. */
function hostOf(href: string): string {
  try {
    return new URL(href).hostname.replace(/^www\./i, "");
  } catch {
    return href.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split(/[/?#]/)[0] ?? href;
  }
}

/** The card's URL line: host and path, without the scheme. */
function urlLine(href: string): string {
  try {
    const u = new URL(href);
    return `${u.host.replace(/^www\./i, "")}${u.pathname === "/" ? "" : u.pathname}${u.search}`;
  } catch {
    return href;
  }
}

/**
 * The chip's label: the link's own text unless it is the URL itself or a bare
 * host, in which case the site's name (or its host) reads better.
 */
export function chipText(href: string, label: string, siteName: string | null): string {
  const host = hostOf(href);
  const bare = label.trim().replace(/\/$/, "");
  const isSelf = bare === href.trim().replace(/\/$/, "");
  const isHost = bare.replace(/^https?:\/\//i, "").replace(/^www\./i, "") === host;
  return isSelf || isHost ? (siteName ?? host) : label;
}

/** One request per URL per session; a failure is asked again after a minute (the main process retries it too). */
const metaCache = new Map<string, Promise<LinkMeta | null>>();
const FAIL_TTL_MS = 60_000;

function linkMeta(url: string): Promise<LinkMeta | null> {
  const hit = metaCache.get(url);
  if (hit) return hit;
  const asked =
    typeof window === "undefined"
      ? Promise.resolve(null)
      : Promise.resolve(window.unskilled?.uiLinkMeta?.(url) ?? null).then(
          (meta) => meta,
          () => null,
        );
  metaCache.set(url, asked);
  void asked.then((meta) => {
    if (meta === null) setTimeout(() => metaCache.get(url) === asked && metaCache.delete(url), FAIL_TTL_MS);
  });
  return asked;
}

/**
 * A link in an agent reply as an inline chip (DESIGN.md §7.4): the site's
 * favicon or a globe, then the link text. After a short hover or focus it
 * shows the page's name, title, description and host from its <head>.
 */
/** A URL's metadata: undefined while it loads, null when previews are off or the page couldn't be read. */
function useLinkMeta(href: string): LinkMeta | null | undefined {
  const [meta, setMeta] = useState<LinkMeta | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setMeta(undefined);
    void linkMeta(href).then((m) => {
      if (live) setMeta(m);
    });
    return () => {
      live = false;
    };
  }, [href]);
  return meta;
}

export function LinkChip({ href, label }: { href: string; label: string }) {
  const meta = useLinkMeta(href);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const cardId = useId();
  const chip = useRef<HTMLAnchorElement>(null);
  const card = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };

  const close = () => {
    clear();
    setOpen(false);
    setPos(null);
  };

  /** Put the card under the chip now; the effect below corrects it once its height is known. */
  const show = () => {
    const el = chip.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.max(CARD_EDGE, Math.min(r.left, window.innerWidth - CARD_W - CARD_EDGE));
    const top = r.bottom + 6 + CARD_EST > window.innerHeight - CARD_EDGE ? Math.max(CARD_EDGE, r.top - 6 - CARD_EST) : r.bottom + 6;
    setPos({ left, top });
    setOpen(true);
  };

  const start = () => {
    if (open) return;
    clear();
    timer.current = setTimeout(() => {
      timer.current = null;
      show();
    }, HOVER_DELAY);
  };

  // Measure the card and move it above the chip when it would pass the window bottom.
  useEffect(() => {
    if (!open) return;
    const el = card.current;
    const anchor = chip.current;
    if (!el || !anchor) return;
    const height = el.getBoundingClientRect().height;
    const r = anchor.getBoundingClientRect();
    const below = r.bottom + 6;
    const top = below + height > window.innerHeight - CARD_EDGE ? Math.max(CARD_EDGE, r.top - 6 - height) : below;
    const left = Math.max(CARD_EDGE, Math.min(r.left, window.innerWidth - CARD_W - CARD_EDGE));
    setPos((p) => (p && p.top === top && p.left === left ? p : { left, top }));
  }, [open, meta]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => clear, []);

  const host = hostOf(href);
  const icon = meta?.icon ?? null;
  return (
    <>
      <a
        ref={chip}
        className="link-chip"
        href={href}
        target="_blank"
        rel="noreferrer"
        title={href}
        aria-describedby={open ? cardId : undefined}
        onMouseEnter={start}
        onMouseLeave={close}
        onFocus={start}
        onBlur={close}
        onKeyDown={(e) => {
          if (e.key === "Escape") close();
        }}
      >
        <span className="link-chip-icon">{icon ? <img alt="" src={icon} /> : <Globe size={12} strokeWidth={1.75} aria-hidden />}</span>
        <span className="link-chip-text">{chipText(href, label, meta?.siteName ?? null)}</span>
      </a>
      {open && pos ? (
        <span ref={card} id={cardId} className="link-card" role="tooltip" style={{ left: pos.left, top: pos.top }}>
          <span className="link-card-head">
            {icon ? <img alt="" src={icon} /> : <Globe size={14} strokeWidth={1.75} aria-hidden />}
            <span className="link-card-site">{meta?.siteName ?? host}</span>
          </span>
          {meta?.title ? <span className="link-card-title">{meta.title}</span> : null}
          {meta?.description ? <span className="link-card-desc">{meta.description}</span> : null}
          <span className="link-card-url">{urlLine(href)}</span>
        </span>
      ) : null}
    </>
  );
}

/** Most link cards under one paragraph or list. */
const CARDS_MAX = 3;

/**
 * Link cards under a paragraph or list, like a chat app's link unfurl: the page's
 * preview image, title, favicon and site, and a line of its description. A card
 * shows once the page's metadata arrives; a page that can't be read (a bot wall,
 * no title) gets a plain card from its URL. With Rich replies "+ link previews"
 * off nothing is drawn.
 */
export function LinkCards({ urls }: { urls: string[] }) {
  const shown = urls.slice(0, CARDS_MAX);
  if (!shown.length) return null;
  return (
    <div className="link-cards">
      {shown.map((u) => (
        <LinkCard key={u} href={u} />
      ))}
    </div>
  );
}

/** A card's title when the page gave none: its host and path, as a reader would say it. */
export function urlTitle(href: string): string {
  const host = hostOf(href);
  try {
    const path = decodeURIComponent(new URL(href).pathname).replace(/\/+$/, "");
    return path ? `${host}${path}` : host;
  } catch {
    return host;
  }
}

function LinkCard({ href }: { href: string }) {
  const meta = useLinkMeta(href);
  const previews = useStore((s) => s.settings?.linkPreviews === true);
  if (!previews || meta === undefined) return null;
  const host = hostOf(href);
  return (
    <a className="link-card-row" href={href} target="_blank" rel="noreferrer" title={href}>
      {meta?.image ? <img className="link-card-thumb" alt="" src={meta.image} /> : null}
      <span className="link-card-main">
        <span className="link-card-title">{meta?.title ?? urlTitle(href)}</span>
        {meta?.description ? <span className="link-card-snippet">{meta.description}</span> : null}
        <span className="link-card-source">
          {meta?.icon ? <img alt="" src={meta.icon} /> : <Globe size={12} strokeWidth={1.75} aria-hidden />}
          <span>{meta?.siteName ?? host}</span>
        </span>
      </span>
    </a>
  );
}
