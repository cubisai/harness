// Type declarations for the design-token reference doc generator.

export type Layer = "color" | "effect" | "type" | "shape" | "layout" | "motion" | "other";

export interface Token {
  name: string;
  light: string;
  dark: string | null;
  systemDark: string | null;
  line: number;
  layer: Layer;
}

export function parseTokens(css: string): Token[];

export function layerOf(name: string): Layer;

export function generateTokensMd(css: string): string;

export function normalizeEol(text: string): string;
