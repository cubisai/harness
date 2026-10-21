// Lucide icons behind the names the app already uses. 16px, currentColor, one stroke weight.
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bell,
  Check,
  ChevronRight,
  ChevronUp,
  Circle,
  CircleDot,
  Copy,
  Crosshair,
  Ellipsis,
  ExternalLink,
  FileDiff,
  Folder,
  Globe,
  Library,
  MessageCircle,
  PanelLeftClose,
  PanelLeftOpen,
  Pin,
  Plus,
  Search,
  RefreshCw,
  Settings,
  ShieldCheck,
  Sparkles,
  SquarePen,
  SquareTerminal,
  X,
  type LucideIcon,
} from "lucide-react";

type P = { size?: number };

const STROKE = 1.75;

const icon = (Glyph: LucideIcon, fallback = 16) =>
  function Icon({ size = fallback }: P) {
    return <Glyph size={size} strokeWidth={STROKE} absoluteStrokeWidth={false} aria-hidden />;
  };

export const IconCompose = icon(SquarePen);
export const IconChat = icon(MessageCircle);
export const IconBell = icon(Bell);
export const IconCheck = icon(Check, 12);
export const IconTodo = icon(Circle, 12);
export const IconTodoActive = icon(CircleDot, 12);
export const IconChevronUp = icon(ChevronUp, 14);
export const IconMore = icon(Ellipsis, 14);
export const IconPin = icon(Pin, 14);
export const IconFolder = icon(Folder);
export const IconPlus = icon(Plus);
export const IconArrowUp = icon(ArrowUp);
export const IconDiff = icon(FileDiff);
export const IconRefresh = icon(RefreshCw);
export const IconSparkle = icon(Sparkles);
export const IconArrowLeft = icon(ArrowLeft);
export const IconArrowRight = icon(ArrowRight);
export const IconGlobe = icon(Globe);
export const IconTarget = icon(Crosshair);
export const IconTerminal = icon(SquareTerminal);
export const IconGear = icon(Settings);
export const IconShield = icon(ShieldCheck, 12);
export const IconLibrary = icon(Library);
export const IconCopy = icon(Copy, 14);
export const IconOpen = icon(ExternalLink, 14);
export const IconSidebarClose = icon(PanelLeftClose);
export const IconSidebarOpen = icon(PanelLeftOpen);
export const IconArchive = icon(Archive, 14);
export const IconSearch = icon(Search);
export const IconClose = icon(X, 14);

/** A filled square: Lucide's Square is an outline, and Stop reads better solid. */
export const IconStop = ({ size = 12 }: P) => (
  <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden>
    <rect x="2" y="2" width="8" height="8" rx="1.5" fill="currentColor" />
  </svg>
);

/** Points right when closed, down when open. */
export const IconChevron = ({ size = 14, open }: P & { open?: boolean }) => (
  <ChevronRight
    size={size}
    strokeWidth={2}
    aria-hidden
    className="chevron"
    style={{ transform: open ? "rotate(90deg)" : undefined, transition: "transform 150ms" }}
  />
);
