import { useEffect, useState } from "react";
import {
  BookOpen,
  ChartColumn,
  CircleCheck,
  CircleDollarSign,
  Clock,
  Code,
  Database,
  FileText,
  FlaskConical,
  Globe,
  Heart,
  Info,
  Layers,
  Lightbulb,
  Link,
  Lock,
  Palette,
  RefreshCw,
  Rocket,
  Search,
  Settings,
  Star,
  Target,
  TriangleAlert,
  User,
  Users,
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useStore } from "../../store";
import { UiActions } from "../UiActions";
import type { CardsSpec } from "../types";

/** Icon words a card's `lead` may use, with synonyms; unknown words draw nothing. */
export const CARD_ICONS: Record<string, LucideIcon> = {
  check: CircleCheck,
  done: CircleCheck,
  ok: CircleCheck,
  file: FileText,
  doc: FileText,
  document: FileText,
  page: FileText,
  bolt: Zap,
  fast: Zap,
  quick: Zap,
  power: Zap,
  link: Link,
  url: Link,
  skill: Wrench,
  tool: Wrench,
  tools: Wrench,
  wrench: Wrench,
  idea: Lightbulb,
  tip: Lightbulb,
  bulb: Lightbulb,
  warning: TriangleAlert,
  warn: TriangleAlert,
  risk: TriangleAlert,
  info: Info,
  note: Info,
  star: Star,
  best: Star,
  code: Code,
  test: FlaskConical,
  flask: FlaskConical,
  browser: Globe,
  web: Globe,
  globe: Globe,
  search: Search,
  find: Search,
  user: User,
  person: User,
  team: Users,
  people: Users,
  time: Clock,
  clock: Clock,
  money: CircleDollarSign,
  cost: CircleDollarSign,
  price: CircleDollarSign,
  chart: ChartColumn,
  stats: ChartColumn,
  lock: Lock,
  security: Lock,
  settings: Settings,
  gear: Settings,
  book: BookOpen,
  learn: BookOpen,
  rocket: Rocket,
  launch: Rocket,
  heart: Heart,
  love: Heart,
  target: Target,
  goal: Target,
  layers: Layers,
  stack: Layers,
  sync: RefreshCw,
  loop: RefreshCw,
  refresh: RefreshCw,
  design: Palette,
  paint: Palette,
  database: Database,
  data: Database,
};

/** Image extensions a `lead` may name, as a URL or a local path. */
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|avif)$/i;
/** Any other URL scheme (http://, file://…) is never treated as a local image path. */
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/** The host of a link without a leading `www.`; `penpot.app` for `https://www.penpot.app/x`. */
function hostname(link: string): string {
  try {
    return new URL(link).hostname.replace(/^www\./i, "");
  } catch {
    return link;
  }
}

/**
 * A row's lead: an icon for a known word (case-insensitive, a trailing "s" is
 * dropped when there is no direct match), an image for an https URL or a local
 * image path, or nothing.
 */
export function leadKind(lead: string | undefined): { kind: "icon"; Icon: LucideIcon } | { kind: "image"; src: string } | { kind: "none" } {
  const raw = lead?.trim();
  if (!raw) return { kind: "none" };
  if (/^https:\/\//i.test(raw)) return { kind: "image", src: raw };
  if (IMAGE_EXT_RE.test(raw) && !SCHEME_RE.test(raw)) return { kind: "image", src: raw };
  const word = raw.toLowerCase();
  const Icon = CARD_ICONS[word] ?? (word.endsWith("s") ? CARD_ICONS[word.slice(0, -1)] : undefined);
  return Icon ? { kind: "icon", Icon } : { kind: "none" };
}

/** Markdown for a cards block: an optional bold title, then one `- **Title** — text (link)` line per row. */
export function cardsMarkdown(spec: CardsSpec): string {
  const lines = spec.items
    .map((item) => {
      let line = `- **${item.title}**`;
      if (item.text) line += ` — ${item.text}`;
      if (item.link) line += ` ([${hostname(item.link)}](${item.link}))`;
      return line;
    })
    .join("\n");
  return spec.title ? `**${spec.title}**\n\n${lines}` : lines;
}

/**
 * A lead thumbnail. The renderer's CSP blocks remote images, so the app fetches
 * the URL (an image, or a page's preview card) and returns a data: URL; until
 * then a neutral Globe tile stands in; when the fetch fails the tile goes.
 */
function CardThumb({ src, kind }: { src: string; kind: "image" | "page" }) {
  const threadId = useStore((s) => s.selectedThreadId);
  const [data, setData] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    if (typeof window !== "undefined" && window.unskilled?.uiImage) {
      void window.unskilled.uiImage(threadId, src, kind).then(
        (url) => {
          if (live) setData(url);
        },
        () => {
          if (live) setData(null);
        },
      );
    } else {
      setData(null);
    }
    return () => {
      live = false;
    };
  }, [threadId, src, kind]);
  if (data === null) return null;
  return (
    <div className="ui-card-lead thumb">
      {typeof data === "string" ? <img src={data} alt="" /> : <Globe size={16} strokeWidth={1.75} aria-hidden />}
    </div>
  );
}

/** Rows in one card: a lead icon or thumbnail, a bold title, an optional link line and text. */
export function Cards({ spec }: { spec: CardsSpec }) {
  // Web pictures need Settings › Load link previews; off, rows keep their icon or go without.
  const web = useStore((s) => s.settings?.linkPreviews === true);
  return (
    <>
      {spec.title ? <div className="ui-title">{spec.title}</div> : null}
      <ul className="ui-cards">
        {spec.items.map((item, i) => {
          const lead = leadKind(item.lead);
          return (
            <li key={i} className="ui-card">
              {lead.kind === "icon" ? (
                <div className="ui-card-lead icon">
                  <lead.Icon size={16} strokeWidth={1.75} aria-hidden />
                </div>
              ) : lead.kind === "image" && (web || !/^https:/i.test(lead.src)) ? (
                <CardThumb src={lead.src} kind="image" />
              ) : item.link && web ? (
                <CardThumb src={item.link} kind="page" />
              ) : null}
              <div className="ui-card-body">
                {item.link ? (
                  <div className="ui-card-title">
                    <a href={item.link} target="_blank" rel="noreferrer">
                      {item.title}
                    </a>
                  </div>
                ) : (
                  <div className="ui-card-title">{item.title}</div>
                )}
                {item.link ? <div className="ui-card-link">{hostname(item.link)} ↗</div> : null}
                {item.text ? <div className="ui-card-text">{item.text}</div> : null}
              </div>
            </li>
          );
        })}
      </ul>
      <UiActions markdown={cardsMarkdown(spec)} />
    </>
  );
}
