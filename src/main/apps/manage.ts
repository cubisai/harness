import { lstatSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AppInfo } from "../../shared/types";
import { assertContained } from "../extensions/install";
import { validateApp } from "./manifest";
import { AppRegistry, decodeAppKey, encodeAppKey, readAppFiles } from "./registry";

/** Copy into a new Creator draft, never edit the installed app or overwrite an existing draft. */
export function prepareAppEdit(registry: AppRegistry, key: string, threadId: string, threadFolder?: string): { app: AppInfo; prompt: string } {
  const source = decodeAppKey(key);
  if (!source || source.scope === "draft") throw new Error("Choose an installed app to edit.");
  const installed = registry.info(key);
  if (!installed) throw new Error("App not found.");
  if (installed.error) throw new Error(installed.error);
  if (lstatSync(installed.path).isSymbolicLink()) throw new Error("The installed app folder is a symlink.");
  const draft = { scope: "draft", threadId, name: source.name } as const;
  const dest = registry.dirOf(draft);
  if (!dest) throw new Error("A Creator thread is required to edit an app.");
  const base = dirname(dest);
  // Drafts must stay in the thread folder, even if .cubiq or app-drafts was replaced with a symlink.
  assertContained(threadFolder ?? dirname(dirname(base)), dest, "app draft");
  const read = readAppFiles(installed.path);
  const valid = validateApp(source.name, read.files);
  if (read.errors.length || !valid.ok) throw new Error([...read.errors, ...(valid.ok ? [] : valid.errors)].join("\n"));
  mkdirSync(base, { recursive: true });
  try {
    mkdirSync(dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new Error("The app draft already exists; it was not overwritten.");
    throw err;
  }
  try {
    for (const file of valid.files) {
      const target = join(dest, ...file.path.split("/"));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.content, { flag: "wx" });
    }
    const app = registry.info(encodeAppKey(draft));
    if (!app || app.error) throw new Error(app?.error ?? "Couldn't open the app draft.");
    return {
      app,
      prompt: `Help me edit the installed app ${JSON.stringify(installed.title)} (${source.name}). Its files have been copied to ${JSON.stringify(dest)}. Edit only this draft, not the installed folder. Use creator_app_preview and creator_app_check, then creator_propose kind:"app" name:"${source.name}" for a reviewed Update. Ask "What would you like to change?" if no requested changes follow.\n\nRequested changes: `,
    };
  } catch (err) {
    // Only this call's newly created folder is rolled back.
    rmSync(dest, { recursive: true, force: true });
    throw err;
  }
}
