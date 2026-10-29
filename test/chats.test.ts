import { describe, expect, it } from "vitest";
import { chatsRoot, isChatDir, isChatsRoot } from "../src/main/chats";

describe("chats paths", () => {
  const root = chatsRoot("/data/CubiQ");

  it("recognises the Chats folder itself", () => {
    expect(isChatsRoot("/data/CubiQ/chats", root, "darwin")).toBe(true);
    expect(isChatsRoot("/data/CubiQ/chats/", root, "darwin")).toBe(true);
    expect(isChatsRoot("/data/CubiQ/Chats", root, "darwin")).toBe(false);
    expect(isChatsRoot("/code/app", root, "darwin")).toBe(false);
    expect(isChatsRoot("/data/CubiQ/chats", null, "darwin")).toBe(false);
  });

  it("matches the Chats folder case-insensitively on Windows", () => {
    expect(isChatsRoot("/DATA/cubiq/CHATS", root, "win32")).toBe(true);
  });

  it("treats only a direct child of the Chats folder as a chat's folder", () => {
    expect(isChatDir("/data/CubiQ/chats/t1", root, "darwin")).toBe(true);
    expect(isChatDir("/data/CubiQ/chats", root, "darwin")).toBe(false);
    expect(isChatDir("/data/CubiQ/chats/t1/sub", root, "darwin")).toBe(false);
    expect(isChatDir("/data/CubiQ/chats/../worktrees/t1", root, "darwin")).toBe(false);
    expect(isChatDir("/data/CubiQ/worktrees/t1", root, "darwin")).toBe(false);
    expect(isChatDir("/data/CubiQ/chats/t1", null, "darwin")).toBe(false);
  });
});
