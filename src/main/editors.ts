import { spawn } from "node:child_process";
import { accessSync, constants, readdirSync, statSync } from "node:fs";
import { posix, win32 } from "node:path";
import type { EditorInfo, OpenResult } from "../shared/types";

/**
 * How an editor takes a line number:
 * - goto: VS Code and its forks, `--goto file:line:col`
 * - suffix: Zed and Sublime Text, `file:line:col`
 * - line-column: JetBrains IDEs, `--line N --column M file`
 * - xed: Xcode, `--line N file`
 */
type LaunchStyle = "goto" | "suffix" | "line-column" | "xed";

interface EditorDef {
  id: string;
  label: string;
  commands: string[];
  style: LaunchStyle;
  /** Bundle names under /Applications, and the CLI inside the bundle. */
  mac?: { apps: string[]; bin: string };
  /** Install folder names under Program Files / LocalAppData\Programs, and the CLI inside. */
  win?: { dirs: string[]; bins: string[] };
  jetbrains?: boolean;
  /** Only on this platform. */
  only?: NodeJS.Platform;
}

const vscodeLike = (id: string, label: string, command: string, macApp: string, winDir: string): EditorDef => ({
  id,
  label,
  commands: [command],
  style: "goto",
  mac: { apps: [macApp], bin: `Contents/Resources/app/bin/${command}` },
  win: { dirs: [winDir], bins: [`bin/${command}.cmd`, `resources/app/bin/${command}.cmd`] },
});

const jetbrains = (id: string, label: string, command: string, apps: string[]): EditorDef => ({
  id,
  label,
  commands: [command],
  style: "line-column",
  jetbrains: true,
  mac: { apps, bin: `Contents/MacOS/${command}` },
  win: { dirs: apps, bins: [`bin/${command}64.exe`, `bin/${command}.exe`] },
});

/** Editors in the order the picker lists them. */
export const EDITORS: EditorDef[] = [
  vscodeLike("cursor", "Cursor", "cursor", "Cursor", "cursor"),
  vscodeLike("vscode", "VS Code", "code", "Visual Studio Code", "Microsoft VS Code"),
  vscodeLike("vscode-insiders", "VS Code Insiders", "code-insiders", "Visual Studio Code - Insiders", "Microsoft VS Code Insiders"),
  vscodeLike("windsurf", "Windsurf", "windsurf", "Windsurf", "Windsurf"),
  vscodeLike("vscodium", "VSCodium", "codium", "VSCodium", "VSCodium"),
  {
    id: "zed",
    label: "Zed",
    commands: ["zed", "zeditor"],
    style: "suffix",
    mac: { apps: ["Zed", "Zed Preview"], bin: "Contents/MacOS/cli" },
    win: { dirs: ["Zed"], bins: ["bin/zed.exe", "zed.exe"] },
  },
  {
    id: "sublime",
    label: "Sublime Text",
    commands: ["subl"],
    style: "suffix",
    mac: { apps: ["Sublime Text"], bin: "Contents/SharedSupport/bin/subl" },
    win: { dirs: ["Sublime Text", "Sublime Text 3"], bins: ["subl.exe"] },
  },
  jetbrains("idea", "IntelliJ IDEA", "idea", ["IntelliJ IDEA", "IntelliJ IDEA Ultimate", "IntelliJ IDEA CE", "IntelliJ IDEA Community Edition"]),
  jetbrains("webstorm", "WebStorm", "webstorm", ["WebStorm"]),
  jetbrains("pycharm", "PyCharm", "pycharm", ["PyCharm", "PyCharm Professional Edition", "PyCharm CE", "PyCharm Community Edition"]),
  jetbrains("goland", "GoLand", "goland", ["GoLand"]),
  jetbrains("rider", "Rider", "rider", ["Rider", "JetBrains Rider"]),
  jetbrains("clion", "CLion", "clion", ["CLion"]),
  jetbrains("rustrover", "RustRover", "rustrover", ["RustRover"]),
  jetbrains("phpstorm", "PhpStorm", "phpstorm", ["PhpStorm"]),
  jetbrains("rubymine", "RubyMine", "rubymine", ["RubyMine"]),
  { id: "xcode", label: "Xcode", commands: ["xed"], style: "xed", only: "darwin" },
];

export interface Host {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** Is this an executable file? */
  isExecutable(path: string): boolean;
  listDir(path: string): string[];
}

export const realHost = (): Host => ({
  platform: process.platform,
  env: process.env,
  isExecutable: (p) => {
    try {
      if (!statSync(p).isFile()) return false;
      accessSync(p, process.platform === "win32" ? constants.F_OK : constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  listDir: (p) => {
    try {
      return readdirSync(p);
    } catch {
      return [];
    }
  },
});

/** Paths in the checked platform's own style, so detection is testable from any OS. */
const pathsFor = (platform: NodeJS.Platform) => (platform === "win32" ? win32 : posix);

function onPath(command: string, host: Host): string | null {
  const { join, delimiter } = pathsFor(host.platform);
  const exts = host.platform === "win32" ? (host.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean) : [""];
  for (const dir of (host.env.PATH ?? host.env.Path ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, command + ext.toLowerCase());
      if (host.isExecutable(candidate)) return candidate;
      if (ext && host.isExecutable(join(dir, command + ext))) return join(dir, command + ext);
    }
  }
  return null;
}

/**
 * Where an editor's command-line launcher is. PATH first, then the places
 * installers put it, because apps started from the Dock or Start menu don't
 * get the shell's PATH: /Applications bundles on macOS, Program Files and
 * LocalAppData on Windows, the usual bin folders on Linux, and JetBrains
 * Toolbox's scripts everywhere.
 */
export function resolveEditor(def: EditorDef, host: Host): string | null {
  if (def.only && def.only !== host.platform) return null;
  const { join } = pathsFor(host.platform);
  for (const command of def.commands) {
    const found = onPath(command, host);
    if (found) return found;
  }
  const home = host.env.HOME ?? host.env.USERPROFILE;
  const candidates: string[] = [];
  if (host.platform === "darwin") {
    for (const root of [...(home ? [join(home, "Applications")] : []), "/Applications"]) {
      for (const app of def.mac?.apps ?? []) candidates.push(join(root, `${app}.app`, def.mac!.bin));
    }
    if (def.jetbrains && home) candidates.push(join(home, "Library/Application Support/JetBrains/Toolbox/scripts", def.commands[0]!));
  } else if (host.platform === "win32") {
    const roots = [
      ...(host.env.LOCALAPPDATA ? [join(host.env.LOCALAPPDATA, "Programs")] : []),
      ...[host.env.ProgramFiles, host.env["ProgramFiles(x86)"], host.env.ProgramW6432].filter((r): r is string => Boolean(r)),
    ];
    if (def.jetbrains && host.env.LOCALAPPDATA) candidates.push(join(host.env.LOCALAPPDATA, "JetBrains/Toolbox/scripts", `${def.commands[0]}.cmd`));
    for (const root of roots) {
      for (const base of def.jetbrains ? [root, join(root, "JetBrains")] : [root]) {
        // JetBrains folders carry a version: "WebStorm 2026.2".
        const dirs = def.jetbrains
          ? host.listDir(base).filter((entry) => def.win!.dirs.some((d) => entry === d || entry.startsWith(`${d} `))).sort().reverse()
          : (def.win?.dirs ?? []);
        for (const dir of dirs) for (const bin of def.win?.bins ?? []) candidates.push(join(base, dir, bin));
      }
    }
  } else {
    const dirs = [...(home ? [join(home, ".local/bin")] : []), "/usr/local/bin", "/usr/bin", "/snap/bin", "/var/lib/flatpak/exports/bin"];
    if (def.jetbrains) {
      const data = host.env.XDG_DATA_HOME || (home ? join(home, ".local/share") : null);
      if (data) dirs.push(join(data, "JetBrains/Toolbox/scripts"));
    }
    for (const dir of dirs) for (const command of def.commands) candidates.push(join(dir, command));
  }
  return candidates.find((c) => host.isExecutable(c)) ?? null;
}

/** The arguments that open `path` at a line, in this editor's dialect. */
export function editorArgs(style: LaunchStyle, path: string, line?: number, column?: number): string[] {
  if (!line) return [path];
  const at = `${path}:${line}${column ? `:${column}` : ""}`;
  switch (style) {
    case "goto":
      return ["--goto", at];
    case "suffix":
      return [at];
    case "line-column":
      return ["--line", String(line), ...(column ? ["--column", String(column)] : []), path];
    case "xed":
      return ["--line", String(line), path];
  }
}

/** Installed editors, found once and kept: detection touches the disk a few dozen times. */
export class Editors {
  private cache: { at: number; list: (EditorInfo & { command: string; def: EditorDef })[] } | null = null;

  constructor(
    private host: Host = realHost(),
    /** Environment variables the app set for its agents (API keys) that an editor mustn't inherit. */
    private private_: () => string[] = () => [],
    private run: (command: string, args: string[], env: NodeJS.ProcessEnv) => Promise<boolean> = launchDetached,
  ) {}

  list(): EditorInfo[] {
    return this.found().map(({ id, label }) => ({ id, label }));
  }

  private found() {
    if (!this.cache || Date.now() - this.cache.at > 60_000) {
      const list = EDITORS.flatMap((def) => {
        const command = resolveEditor(def, this.host);
        return command ? [{ id: def.id, label: def.label, command, def }] : [];
      });
      this.cache = { at: Date.now(), list };
    }
    return this.cache.list;
  }

  /**
   * Open a file (at a line) or a folder in `editorId`, or the first editor
   * found. A launcher that vanished since detection refreshes the list once.
   */
  async open(target: { path: string; line?: number; column?: number }, editorId: string | null): Promise<OpenResult> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const list = this.found();
      const editor = (editorId && list.find((e) => e.id === editorId)) || list[0];
      if (!editor) return { ok: false, error: "No editor found. Install one, like VS Code, Cursor, or Zed." };
      if (!this.host.isExecutable(editor.command)) {
        this.cache = null;
        continue;
      }
      const args = editorArgs(editor.def.style, target.path, target.line, target.column);
      const ok = await this.run(editor.command, args, this.cleanEnv());
      return ok ? { ok: true, editor: editor.id } : { ok: false, error: `${editor.label} didn't start.` };
    }
    return { ok: false, error: "The editor was uninstalled. Pick another." };
  }

  /** Our environment minus what's ours: the agents' API keys and Electron's own variables. */
  private cleanEnv(): NodeJS.ProcessEnv {
    const env = { ...this.host.env };
    for (const key of this.private_()) delete env[key];
    for (const key of Object.keys(env)) if (key.startsWith("ELECTRON_") || key === "NODE_OPTIONS") delete env[key];
    return env;
  }
}

/** Quote one argument for cmd.exe, which runs the .cmd launchers editors ship on Windows. */
export function quoteForCmd(arg: string): string {
  if (/["\r\n]/.test(arg)) throw new Error("That path can't be passed to the editor.");
  return /[\s&()^|<>%!,;=]/.test(arg) || arg === "" ? `"${arg.replace(/%/g, "%%")}"` : arg;
}

/**
 * Start the editor on its own: detached, no stdio, and not waited for.
 * A launcher that fails right away (a broken install) counts as not
 * started; one still running after a moment counts as started.
 */
export function launchDetached(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<boolean> {
  return new Promise((resolve) => {
    // Node won't spawn .cmd/.bat without a shell; go through cmd.exe with each argument quoted.
    const viaCmd = process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
    const child = viaCmd
      ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${[quoteForCmd(command), ...args.map(quoteForCmd)].join(" ")}"`], {
          detached: true,
          stdio: "ignore",
          env,
          windowsHide: true,
          windowsVerbatimArguments: true,
        })
      : spawn(command, args, { detached: true, stdio: "ignore", env });
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => done(true), 800);
    child.once("error", () => done(false));
    // CLI launchers often hand off to the running app and exit 0 at once.
    child.once("exit", (code) => done(code === 0));
    child.unref();
  });
}
