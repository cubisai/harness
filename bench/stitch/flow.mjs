// Stitch taste run, rate-limit careful: one call at a time, no generation retries, resumable per file.
//   node flow.mjs <out dir> <prompt file.md>...     (STITCH_API_KEY from env, never printed)
//   node flow.mjs <out dir> --recover <projectId> <name>   (download every screen of an existing project)
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const KEY = process.env.STITCH_API_KEY;
if (!KEY) throw new Error("STITCH_API_KEY not set");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const GEN_GAP_MS = 20_000;
let rateStrikes = 0;

class RateLimited extends Error {}

let rpcId = 1;
async function call(name, args, maxSec = 900) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method: "tools/call", params: { name, arguments: args } });
  let stdout;
  try {
    stdout = await new Promise((resolve, reject) => {
      const child = execFile("curl", ["-sS", "--max-time", String(maxSec), "https://stitch.googleapis.com/mcp", "-H", `X-Goog-Api-Key: ${KEY}`, "-H", "Content-Type: application/json", "-H", "Accept: application/json, text/event-stream", "--data-binary", "@-"], { maxBuffer: 256 * 1024 * 1024 }, (err, out, errOut) => (err ? reject(new Error(String(errOut || err.message).replaceAll(KEY, "***"))) : resolve(out)));
      child.stdin.end(body);
    });
  } catch (e) {
    throw new Error(`${name}: transport ${String(e.message).slice(0, 160)}`);
  }
  let text = stdout;
  const data = text.split("\n").filter((l) => l.startsWith("data:")).pop();
  if (data) text = data.slice(5);
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    if (/429|RESOURCE_EXHAUSTED|rate/i.test(text)) throw new RateLimited(text.slice(0, 200));
    throw new Error(`${name}: bad reply ${text.slice(0, 200)}`);
  }
  const errText = JSON.stringify(msg.error ?? (msg.result?.isError ? msg.result.content : ""));
  if (/429|RESOURCE_EXHAUSTED|quota|rate.?limit/i.test(errText)) throw new RateLimited(`${name}: ${errText.slice(0, 200)}`);
  if (msg.error || msg.result?.isError) throw new Error(`${name}: ${errText.slice(0, 300)}`);
  const r = msg.result;
  return r?.structuredContent ?? JSON.parse(r?.content?.find((c) => c.type === "text")?.text ?? "{}");
}

/** A call that waits out rate limits (2, 4, 8 min) and gives up after three in a row. */
async function careful(name, args, maxSec) {
  for (;;) {
    try {
      const r = await call(name, args, maxSec);
      rateStrikes = 0;
      return r;
    } catch (e) {
      if (!(e instanceof RateLimited)) throw e;
      rateStrikes++;
      if (rateStrikes > 3) throw new Error(`rate limited 3 times in a row, stopping: ${e.message}`);
      const wait = 60_000 * 2 ** rateStrikes;
      log(`rate limited (${e.message.slice(0, 80)}); waiting ${wait / 60000} min`);
      await sleep(wait);
    }
  }
}

const screenIds = (project) => (project.screens ?? []).map((s) => String(s.name).split("/").pop());
async function listScreens(projectId) {
  return (await careful("list_screens", { projectId })).screens ?? [];
}
/** Real UI screens (image and logo assets Stitch makes along the way have no device type). */
const isUi = (s) => Boolean(s.deviceType) && s.deviceType !== "DEVICE_TYPE_UNSPECIFIED";
async function uiScreens(projectId) {
  return (await listScreens(projectId)).filter(isUi);
}

/** Generation-like calls: never retried; on a transport failure, poll for new screens (30 s × 10). */
async function generate(name, args, projectId) {
  const before = new Set((await listScreens(projectId)).map((s) => s.name));
  await sleep(GEN_GAP_MS);
  try {
    const r = await careful(name, args, 900);
    return r;
  } catch (e) {
    if (String(e.message).startsWith("rate limited")) throw e;
    log(`${name} failed (${e.message.slice(0, 120)}); polling for its screens`);
    for (let i = 0; i < 10; i++) {
      await sleep(30_000);
      const now = await listScreens(projectId);
      if (now.some((s) => !before.has(s.name))) return { recovered: true };
    }
    return { failed: e.message };
  }
}

const slug = (s) => String(s || "screen").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
async function downloadAll(projectId, dir, done) {
  for (const s of await listScreens(projectId)) {
    const id = String(s.name).split("/").pop();
    if (done.has(id)) continue;
    const base = `${slug(s.title)}-${id.slice(0, 6)}`;
    for (const f of [s.htmlCode, s.screenshot].filter(Boolean)) {
      try {
        const file = await careful("download_file", { name: f.name });
        if (file.html) writeFileSync(join(dir, `${base}.html`), file.html);
        if (file.image) writeFileSync(join(dir, `${base}.png`), Buffer.from(file.image, "base64"));
      } catch (e) {
        log(`download ${base}: ${e.message.slice(0, 120)}`);
      }
    }
    writeFileSync(join(dir, `${base}.json`), JSON.stringify(s, null, 2));
    done.add(id);
  }
}

/** The fenced block right after a heading line matching `re`, from `from` on. */
function blockAfter(md, re, from = 0) {
  const lines = md.split("\n");
  for (let i = from; i < lines.length; i++) {
    if (!re.test(lines[i])) continue;
    let j = i + 1;
    while (j < lines.length && !lines[j].startsWith("```")) j++;
    let k = j + 1;
    while (k < lines.length && !lines[k].startsWith("```")) k++;
    return { text: lines.slice(j + 1, k).join("\n").trim(), end: k };
  }
  return null;
}

function parseFile(md) {
  const fm = Object.fromEntries([...md.matchAll(/^(\w+):\s*(.+)$/gm)].slice(0, 8).map((m) => [m[1], m[2]]));
  const designMd = blockAfter(md, /^### Step 1/)?.text ?? "";
  const step2 = md.indexOf("### Step 2");
  const step3 = md.indexOf("### Step 3");
  const gen = md.slice(step2, step3);
  const batches = [];
  const re = /```\n([\s\S]*?)\n```/g;
  let m;
  while ((m = re.exec(gen))) batches.push(m[1].trim());
  const unify = blockAfter(md, /^### Step 3/)?.text ?? "";
  const step4 = md.slice(md.indexOf("### Step 4"));
  const refine = [...step4.split("## Swap knobs")[0].matchAll(/^- "(.+)"$/gm)].map((x) => x[1]);
  const device = /mobile/i.test(fm.platform ?? "") ? "MOBILE" : "DESKTOP";
  return { id: fm.id, title: fm.title, device, designMd, batches, unify, refine };
}

async function flow(outDir, file) {
  const spec = parseFile(readFileSync(file, "utf8"));
  const dir = join(outDir, `${spec.id}-${slug(spec.title)}`);
  mkdirSync(dir, { recursive: true });
  const stateFile = join(dir, "state.json");
  const st = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { steps: {} };
  const save = () => writeFileSync(stateFile, JSON.stringify(st, null, 2));
  log(`${spec.id} ${spec.title}: ${spec.batches.length} batches, ${spec.refine.length} refines, design.md ${spec.designMd.length} chars`);

  if (!st.projectId) {
    const p = await careful("create_project", { title: `CubiQ taste ${spec.id} ${spec.title}` });
    st.projectId = String(p.name).replace(/^projects\//, "");
    save();
  }
  const projectId = st.projectId;

  // Step 1: the Design.md becomes the project's design system; if that fails, each prompt carries it instead.
  if (!st.steps.designMd) {
    try {
      await careful("upload_design_md", { projectId, designMdBase64: Buffer.from(spec.designMd, "utf8").toString("base64") });
      const project = await careful("get_project", { name: `projects/${projectId}` });
      const inst = (project.screenInstances ?? []).at(-1);
      if (inst) await careful("create_design_system_from_design_md", { projectId, deviceType: spec.device, selectedScreenInstance: { id: inst.id, sourceScreen: inst.sourceScreen } });
      const systems = await careful("list_design_systems", { projectId });
      st.designSystem = JSON.stringify(systems).match(/assets\/\d+/)?.[0] ?? null;
      st.steps.designMd = st.designSystem ? "system" : "inline";
    } catch (e) {
      log(`${spec.id} design.md as a system failed (${e.message.slice(0, 120)}); prompts will carry it`);
      st.steps.designMd = "inline";
    }
    save();
  }
  const withDs = (prompt) => (st.steps.designMd === "inline" ? `${prompt}\n\nFollow this Design.md exactly:\n${spec.designMd}` : prompt);

  // Step 2: batches, one at a time.
  for (let i = 0; i < spec.batches.length; i++) {
    const key = `batch${i}`;
    if (st.steps[key]) continue;
    log(`${spec.id} batch ${i + 1}/${spec.batches.length}`);
    const before = (await uiScreens(projectId)).length;
    const r = await generate("generate_screen_from_text", { projectId, prompt: withDs(spec.batches[i]), deviceType: spec.device, modelId: "GEMINI_3_8_FLASH", ...(st.designSystem ? { designSystem: st.designSystem } : {}) }, projectId);
    st.steps[key] = r.failed ? `failed: ${r.failed.slice(0, 100)}` : "ok";
    save();
    // Stitch sometimes builds fewer screens than the batch describes: build the missing ones one at a time.
    const parts = spec.batches[i].split(/\n\s*\n/);
    const intro = parts.filter((p) => !/^Screen \d+/i.test(p.trim())).join("\n\n");
    const screens = parts.filter((p) => /^Screen \d+/i.test(p.trim()));
    // Stitch may still be adding the batch's screens: wait until the count holds for two 30 s polls (max 4 min).
    let count = (await uiScreens(projectId)).length;
    for (let w = 0, still = 0; w < 8 && still < 2; w++) {
      await sleep(30_000);
      const now = (await uiScreens(projectId)).length;
      still = now === count ? still + 1 : 0;
      count = now;
    }
    const made = count - before;
    for (let k = Math.max(made, 0); k < screens.length; k++) {
      const sub = `${key}-screen${k + 1}`;
      if (st.steps[sub]) continue;
      log(`${spec.id} batch ${i + 1}: missing screen ${k + 1}/${screens.length}, building it alone`);
      const rr = await generate("generate_screen_from_text", { projectId, prompt: withDs(`${intro}\n\n${screens[k]}`), deviceType: spec.device, modelId: "GEMINI_3_8_FLASH", ...(st.designSystem ? { designSystem: st.designSystem } : {}) }, projectId);
      st.steps[sub] = rr.failed ? `failed: ${rr.failed.slice(0, 100)}` : "ok";
      save();
    }
  }
  // Step 3: unify every screen.
  if (!st.steps.unify && spec.unify) {
    const ids = (await uiScreens(projectId)).map((s) => String(s.name).split("/").pop());
    if (ids.length) {
      log(`${spec.id} unify ${ids.length} screens`);
      const r = await generate("edit_screens", { projectId, selectedScreenIds: ids, prompt: spec.unify, deviceType: spec.device, modelId: "GEMINI_3_8_FLASH" }, projectId);
      st.steps.unify = r.failed ? `failed: ${r.failed.slice(0, 100)}` : "ok";
      save();
    }
  }
  // Step 4: refines, one change each, on the screen they name ("On Home, …"), else as a new screen.
  for (let i = 0; i < spec.refine.length; i++) {
    const key = `refine${i}`;
    if (st.steps[key]) continue;
    const prompt = spec.refine[i];
    const target = prompt.match(/^On (?:the )?([^,]+),/i)?.[1]?.toLowerCase();
    const screens = await uiScreens(projectId);
    // "On Home, …" edits that screen (else the closest UI screen by words); "Make …" edits the first; "Add/Show/Create …" is new.
    const words = (target ?? "").split(/\s+/).filter((w) => w.length > 2);
    const named = target
      ? (screens.filter((s) => String(s.title ?? "").toLowerCase().includes(target)).at(-1) ??
        screens.find((s) => words.some((w) => String(s.title ?? "").toLowerCase().includes(w))) ??
        screens[0])
      : undefined;
    const hit = named ?? (!target && /^(make|increase|tighten|give|reduce)\b/i.test(prompt) ? screens[0] : undefined);
    log(`${spec.id} refine ${i + 1}/${spec.refine.length}${hit ? ` on "${hit.title}"` : " (new screen)"}`);
    const r = hit
      ? await generate("edit_screens", { projectId, selectedScreenIds: [String(hit.name).split("/").pop()], prompt, deviceType: spec.device, modelId: "GEMINI_3_8_FLASH" }, projectId)
      : await generate("generate_screen_from_text", { projectId, prompt: withDs(`${spec.title}, same design as the other screens: ${prompt}`), deviceType: spec.device, modelId: "GEMINI_3_8_FLASH", ...(st.designSystem ? { designSystem: st.designSystem } : {}) }, projectId);
    st.steps[key] = r.failed ? `failed: ${r.failed.slice(0, 100)}` : "ok";
    save();
  }
  const done = new Set(st.downloaded ?? []);
  await downloadAll(projectId, dir, done);
  st.downloaded = [...done];
  save();
  log(`${spec.id} done: ${done.size} screens`);
}

const [, , outDir, ...rest] = process.argv;
mkdirSync(outDir, { recursive: true });
if (rest[0] === "--parse") {
  for (const f of rest.slice(1)) {
    const p = parseFile(readFileSync(f, "utf8"));
    console.log(p.id, p.device, p.title, "| design.md", p.designMd.length, "| batches", p.batches.map((b) => b.length).join(","), "| unify", p.unify.length, "| refine", p.refine.length, p.refine.map((r) => r.match(/^On (?:the )?([^,]+),/i)?.[1] ?? "NEW").join(" / "));
  }
} else if (rest[0] === "--recover") {
  const dir = join(outDir, rest[2]);
  mkdirSync(dir, { recursive: true });
  await downloadAll(rest[1], dir, new Set());
  log(`recovered ${rest[2]}`);
} else {
  for (const f of rest) {
    try {
      await flow(outDir, f);
    } catch (e) {
      log(`${basename(f)} stopped: ${e.message.slice(0, 200)}`);
      if (String(e.message).startsWith("rate limited")) break;
    }
  }
}
