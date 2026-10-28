import { useCallback, useEffect, useRef, useState } from "react";
import { SPLASH_IDS, type Splash as SplashKind } from "../../../shared/types";
import { useStore } from "../store";
import agentClip from "../assets/splash/agent.webm";
import agentPoster from "../assets/splash/agent.jpg";
import voyageClip from "../assets/splash/voyage.webm";
import voyagePoster from "../assets/splash/voyage.jpg";
import marketClip from "../assets/splash/market.webm";
import marketPoster from "../assets/splash/market.jpg";
import broomClip from "../assets/splash/broom.webm";
import broomPoster from "../assets/splash/broom.jpg";
import islandClip from "../assets/splash/island.webm";
import islandPoster from "../assets/splash/island.jpg";
import sakuraClip from "../assets/splash/sakura.webm";
import sakuraPoster from "../assets/splash/sakura.jpg";
import neonClip from "../assets/splash/neon.webm";
import neonPoster from "../assets/splash/neon.jpg";
import dragonClip from "../assets/splash/dragon.webm";
import dragonPoster from "../assets/splash/dragon.jpg";
import coderClip from "../assets/splash/coder.webm";
import coderPoster from "../assets/splash/coder.jpg";

/** The launch clips: silent VP9 loops whose last second fades into the first, so they loop without a seam. */
export const SPLASHES: { id: SplashKind; label: string }[] = [
  { id: "agent", label: "CubiQ agent" },
  { id: "voyage", label: "Night voyage" },
  { id: "market", label: "Lantern street" },
  { id: "broom", label: "Broom flight" },
  { id: "island", label: "Sky island" },
  { id: "sakura", label: "Sakura pond" },
  { id: "neon", label: "Neon alley" },
  { id: "dragon", label: "Dragon temple" },
  { id: "coder", label: "Late-night code" },
  { id: "off", label: "Off" },
];
const MEDIA: Record<Exclude<SplashKind, "off">, { clip: string; poster: string }> = {
  agent: { clip: agentClip, poster: agentPoster },
  voyage: { clip: voyageClip, poster: voyagePoster },
  market: { clip: marketClip, poster: marketPoster },
  broom: { clip: broomClip, poster: broomPoster },
  island: { clip: islandClip, poster: islandPoster },
  sakura: { clip: sakuraClip, poster: sakuraPoster },
  neon: { clip: neonClip, poster: neonPoster },
  dragon: { clip: dragonClip, poster: dragonPoster },
  coder: { clip: coderClip, poster: coderPoster },
};

/** Shown at least this long, and until startup has loaded. */
const MIN_MS = 3000;
const FADE_MS = 420;
// Mirrors the setting so the first frame already shows the right clip, before settings load.
const KEY = "cubiq.splash";

function remembered(): SplashKind {
  try {
    const v = localStorage.getItem(KEY);
    if (SPLASH_IDS.includes(v as SplashKind)) return v as SplashKind;
  } catch {
    // Storage blocked: fall back to the default.
  }
  return "agent";
}

function remember(v: SplashKind): void {
  try {
    localStorage.setItem(KEY, v);
  } catch {
    // Storage blocked: the next launch uses the default until settings load.
  }
}

const replays = new Set<() => void>();
let visible = false;

/** Plays the chosen splash again (the Settings preview). */
export function playSplash(): void {
  for (const f of replays) f();
}

/** The splash is on screen; sheets leave Escape to it. */
export function splashVisible(): boolean {
  return visible;
}

/** A full-window looping clip at launch, like a live wallpaper. A click or any key skips it. */
export function Splash() {
  const settings = useStore((s) => s.settings);
  const initError = useStore((s) => s.initError);
  const [kind, setKind] = useState<SplashKind>(() => (import.meta.env.VITE_MOCK ? "off" : remembered()));
  const [phase, setPhase] = useState<"on" | "fading" | "gone">(() => (kind === "off" ? "gone" : "on"));
  const [minDone, setMinDone] = useState(false);
  const [run, setRun] = useState(0);
  const timer = useRef<number | undefined>(undefined);

  // The clip is a wallpaper the user picked (Settings → Splash, with Off), so only the app's own Motion setting stills it.
  // The OS reduce-motion flag doesn't: macOS "Reduce motion" and Windows "Animation effects" off (Remote Desktop, VMs)
  // otherwise left a still poster with no way to get the chosen clip back.
  const still = settings?.motion === "instant";

  const dismiss = useCallback(() => {
    if (still) return setPhase("gone");
    setPhase((p) => (p === "on" ? "fading" : p));
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setPhase("gone"), FADE_MS);
  }, [still]);

  // Settings are the source of truth; a stale mirror swaps clips or hides the launch splash.
  const chosen = settings ? (settings.splash ?? "agent") : null;
  useEffect(() => {
    if (!chosen) return;
    remember(chosen);
    if (run > 0) return;
    if (chosen === "off") setPhase("gone");
    else setKind(chosen);
  }, [chosen, run]);

  useEffect(() => {
    const replay = () => {
      const pick = useStore.getState().settings?.splash ?? "agent";
      if (pick === "off") return;
      window.clearTimeout(timer.current);
      setKind(pick);
      setMinDone(false);
      setPhase("on");
      setRun((r) => r + 1);
    };
    replays.add(replay);
    return () => {
      replays.delete(replay);
    };
  }, []);

  useEffect(() => {
    if (phase !== "on") return;
    const t = window.setTimeout(() => setMinDone(true), MIN_MS);
    return () => window.clearTimeout(t);
  }, [phase, run]);

  useEffect(() => {
    if (phase === "on" && minDone && (settings || initError)) dismiss();
  }, [phase, minDone, settings, initError, dismiss]);

  useEffect(() => {
    visible = phase !== "gone";
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dismiss();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [phase, dismiss]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  if (phase === "gone" || kind === "off") return null;
  const media = MEDIA[kind];
  return (
    <div className={`splash${phase === "fading" ? " fading" : ""}`} role="presentation" aria-hidden="true" onMouseDown={dismiss}>
      {/* Full bleed, like a wallpaper: a window that isn't 16:9 trims the clip's edges rather than showing bands. */}
      {still ? <img src={media.poster} alt="" /> : <video key={`${kind}-${run}`} src={media.clip} poster={media.poster} autoPlay muted loop playsInline disablePictureInPicture />}
    </div>
  );
}
