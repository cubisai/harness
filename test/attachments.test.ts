import { existsSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ATTACHMENTS_DIR,
  MAX_ATTACHMENT_BYTES,
  attachmentNote,
  checkedAttachments,
  inlineImages,
  mediaTypeOf,
  safeName,
  saveAttachments,
} from "../src/main/attachments";
import { acpImageBlocks } from "../src/main/agents/acp/driver";
import { claudePrompt } from "../src/main/agents/claude";
import { SAFE_DEFAULTS } from "../src/main/agents/capabilities";
import type { AgentDriver, TurnInput } from "../src/main/agents/types";
import { Store } from "../src/main/db";
import { buildCheckpoint } from "../src/main/handoff";
import { Service } from "../src/main/service";
import type { Attachment } from "../src/shared/types";
import { catalog, closeAfter, tempDir } from "./helpers";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

describe("saveAttachments", () => {
  it("copies pasted bytes and files on disk into .cubiq/attachments and describes them", () => {
    const root = tempDir();
    const src = join(tempDir(), "report.pdf");
    writeFileSync(src, "%PDF-1.4 hello");
    const saved = saveAttachments(root, [
      { name: "shot.png", bytes: PNG },
      { name: "report.pdf", path: src },
    ]);
    expect(saved).toHaveLength(2);
    expect(saved[0]).toMatchObject({ name: "shot.png", size: PNG.length, mediaType: "image/png" });
    expect(saved[1]).toMatchObject({ name: "report.pdf", size: 14, mediaType: "application/pdf" });
    for (const a of saved) {
      expect(a.path.startsWith(`${ATTACHMENTS_DIR}/`)).toBe(true);
      expect(existsSync(join(root, ...a.path.split("/")))).toBe(true);
    }
    expect(readFileSync(join(root, saved[1]!.path), "utf8")).toBe("%PDF-1.4 hello");
    // Attachments never end up in the user's commits.
    expect(readFileSync(join(root, ".cubiq", "attachments", ".gitignore"), "utf8")).toBe("*\n");
  });

  it("keeps the same name apart and never overwrites", () => {
    const root = tempDir();
    const [a] = saveAttachments(root, [{ name: "a.txt", bytes: new TextEncoder().encode("one") }]);
    const [b] = saveAttachments(root, [{ name: "a.txt", bytes: new TextEncoder().encode("two") }]);
    expect(a!.path).not.toBe(b!.path);
    expect(readFileSync(join(root, a!.path), "utf8")).toBe("one");
  });

  it("refuses more than 10 files, oversized files and folders, and rolls back what it wrote", () => {
    const root = tempDir();
    const eleven = Array.from({ length: 11 }, (_, i) => ({ name: `f${i}.txt`, bytes: new Uint8Array([1]) }));
    expect(() => saveAttachments(root, eleven)).toThrow(/At most 10/);
    expect(() => saveAttachments(root, [{ name: "big.bin", bytes: new Uint8Array(MAX_ATTACHMENT_BYTES + 1) }])).toThrow(/over 20 MB/);
    const folder = tempDir();
    expect(() =>
      saveAttachments(root, [
        { name: "ok.txt", bytes: new Uint8Array([1]) },
        { name: "dir", path: folder },
      ]),
    ).toThrow(/isn't a file/);
    const left = readdirSync(join(root, ".cubiq", "attachments")).filter((n) => n !== ".gitignore");
    expect(left).toEqual([]);
  });

  it("refuses a .cubiq that was swapped for a symlink out of the thread's folder", () => {
    const root = tempDir();
    const outside = tempDir();
    symlinkSync(outside, join(root, ".cubiq"), process.platform === "win32" ? "junction" : "dir");
    expect(() => saveAttachments(root, [{ name: "a.txt", bytes: new Uint8Array([1]) }])).toThrow();
    expect(existsSync(join(outside, "attachments", "a.txt"))).toBe(false);
  });

  it("makes names safe on every OS", () => {
    expect(safeName("../../etc/passwd")).toBe("passwd");
    expect(safeName("C:\\Users\\me\\a:b?.txt")).toBe("a_b_.txt");
    expect(safeName("...")).toBe("file");
    const long = safeName(`${"x".repeat(200)}.pdf`);
    expect(long).toHaveLength(80);
    expect(long.endsWith(".pdf")).toBe(true);
  });

  it("types images by their bytes, not their name", () => {
    expect(mediaTypeOf("not-really.txt", PNG)).toBe("image/png");
    expect(mediaTypeOf("fake.png", new Uint8Array([1, 2, 3]))).toBe("application/octet-stream");
    expect(mediaTypeOf("notes.md", new Uint8Array([1]))).toBe("text/markdown");
  });
});

describe("checkedAttachments", () => {
  it("keeps only real files in the thread's attachments folder", () => {
    const root = tempDir();
    const [a] = saveAttachments(root, [{ name: "a.png", bytes: PNG }]);
    writeFileSync(join(root, "secret.txt"), "x");
    const sent: unknown[] = [
      a,
      { path: "secret.txt", name: "s", size: 1, mediaType: "text/plain" },
      { path: `${ATTACHMENTS_DIR}/../../secret.txt`, name: "s", size: 1, mediaType: "text/plain" },
      { path: `${ATTACHMENTS_DIR}/.gitignore`, name: "g", size: 1, mediaType: "text/plain" },
      { path: `${ATTACHMENTS_DIR}/missing.txt`, name: "m", size: 1, mediaType: "text/plain" },
      { path: 3 },
      null,
    ];
    // The size comes from disk, not from what the renderer said.
    expect(checkedAttachments(root, [{ ...a!, size: 999 }, ...sent.slice(1)])).toEqual([a]);
    expect(checkedAttachments(root, "nope")).toEqual([]);
  });
});

describe("prompt and image input", () => {
  const att = (over: Partial<Attachment>): Attachment => ({ path: `${ATTACHMENTS_DIR}/x-a.png`, name: "a.png", size: 10, mediaType: "image/png", ...over });

  it("lists every attachment's path in the prompt note", () => {
    expect(attachmentNote([])).toBe("");
    const note = attachmentNote([att({}), att({ path: `${ATTACHMENTS_DIR}/y-r.pdf`, name: "r.pdf", mediaType: "application/pdf", size: 2048 })]);
    expect(note).toContain(`- ${ATTACHMENTS_DIR}/x-a.png (a.png, image/png, 10 B)`);
    expect(note).toContain(`- ${ATTACHMENTS_DIR}/y-r.pdf (r.pdf, application/pdf, 2 KB)`);
  });

  it("sends only small png/jpeg/gif/webp images as image input", () => {
    const root = tempDir();
    const images = inlineImages(root, [
      att({}),
      att({ mediaType: "image/svg+xml" }),
      att({ mediaType: "application/pdf" }),
      att({ size: 6 * 1024 * 1024 }),
    ]);
    expect(images).toEqual([{ path: join(root, ".cubiq", "attachments", "x-a.png"), mediaType: "image/png" }]);
  });

  it("Claude: the plain prompt without images, one streamed message with image blocks then the text with them", async () => {
    expect(claudePrompt("hi")).toBe("hi");
    const file = join(tempDir(), "a.png");
    writeFileSync(file, PNG);
    const prompt = claudePrompt("look", [{ path: file, mediaType: "image/png" }, { path: join(tempDir(), "gone.png"), mediaType: "image/png" }]);
    expect(typeof prompt).not.toBe("string");
    const messages = [];
    for await (const m of prompt as AsyncIterable<unknown>) messages.push(m);
    expect(messages).toEqual([
      {
        type: "user",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from(PNG).toString("base64") } },
            { type: "text", text: "look" },
          ],
        },
      },
    ]);
  });

  it("ACP: image blocks only for an agent that says it takes images", () => {
    const file = join(tempDir(), "a.png");
    writeFileSync(file, PNG);
    const images = [{ path: file, mediaType: "image/png" }];
    expect(acpImageBlocks({}, images)).toEqual([]);
    expect(acpImageBlocks({ agentCapabilities: { promptCapabilities: { image: false } } }, images)).toEqual([]);
    expect(acpImageBlocks({ agentCapabilities: { promptCapabilities: { image: true } } }, images)).toEqual([
      { type: "image", mimeType: "image/png", data: Buffer.from(PNG).toString("base64") },
    ]);
    expect(acpImageBlocks({ agentCapabilities: { promptCapabilities: { image: true } } }, undefined)).toEqual([]);
  });
});

describe("Service.send with attachments", () => {
  function setup() {
    const inputs: TurnInput[] = [];
    const driver: AgentDriver = {
      id: "fake",
      label: "Fake",
      defaultModel: "m1",
      capabilities: SAFE_DEFAULTS,
      skillsDelivery: { mode: "none" },
      skillCallPrefix: "skilled:",
      models: () => [{ id: "m1", label: "Model 1" }],
      async runTurn(input: TurnInput) {
        inputs.push(input);
        input.onSession("s1");
        input.onEvent({ kind: "assistant-text", text: "ok" });
      },
    };
    const store = new Store(join(tempDir(), "t.db"));
    closeAfter(() => store.close());
    const service = new Service(store, () => catalog(), [driver], () => {});
    const project = store.addProject(tempDir());
    const thread = service.createThread(project.id);
    return { store, service, thread, inputs, root: project.path };
  }

  it("stores the attachments on the user event, lists them in the prompt and passes images to the driver", async () => {
    const { store, service, thread, inputs, root } = setup();
    const saved = saveAttachments(root, [
      { name: "shot.png", bytes: PNG },
      { name: "notes.txt", bytes: new TextEncoder().encode("hello") },
    ]);
    const forged = { path: "../outside.txt", name: "x", size: 1, mediaType: "text/plain" };
    await service.send({ threadId: thread.id, text: "", attachments: [...saved, forged] });
    const user = store.listEvents(thread.id).find((e) => e.event.kind === "user")!.event;
    expect(user).toEqual({ kind: "user", text: "", attachments: saved });
    expect(inputs[0]!.prompt).toContain(saved[0]!.path);
    expect(inputs[0]!.prompt).toContain(saved[1]!.path);
    expect(inputs[0]!.prompt).not.toContain("outside.txt");
    expect(inputs[0]!.images).toEqual([{ path: join(root, ...saved[0]!.path.split("/")), mediaType: "image/png" }]);
    // A message that is only files is named after the first one.
    expect(store.getThread(thread.id).title).toBe("shot.png");
  });

  it("a send without attachments looks as before", async () => {
    const { store, service, thread, inputs } = setup();
    await service.send({ threadId: thread.id, text: "hi" });
    expect(store.listEvents(thread.id).find((e) => e.event.kind === "user")!.event).toEqual({ kind: "user", text: "hi" });
    expect(inputs[0]!.images).toBeUndefined();
    expect(inputs[0]!.prompt).not.toContain("attached");
  });

  it("the handoff checkpoint carries attachment paths, not contents", async () => {
    const { store, service, thread, root } = setup();
    const saved = saveAttachments(root, [{ name: "r.pdf", bytes: new TextEncoder().encode("%PDF") }]);
    await service.send({ threadId: thread.id, text: "summarise this", attachments: saved });
    const cp = await buildCheckpoint(store, thread.id);
    expect(cp.messages[0]).toEqual({ role: "user", text: `summarise this\n(Attached: ${saved[0]!.path})` });
  });
});
