import { contextBridge, ipcRenderer } from "electron";
import type { LiveUpdate, UnskilledApi } from "../shared/types";

const api: UnskilledApi = {
  platform: process.platform,
  listProjects: () => ipcRenderer.invoke("projects:list"),
  addProject: () => ipcRenderer.invoke("projects:add"),
  listThreads: (projectId) => ipcRenderer.invoke("threads:list", projectId),
  createThread: (projectId, agent) => ipcRenderer.invoke("threads:create", projectId, agent),
  updateThread: (threadId, patch) => ipcRenderer.invoke("threads:update", threadId, patch),
  deleteThread: (threadId) => ipcRenderer.invoke("threads:delete", threadId),
  listEvents: (threadId) => ipcRenderer.invoke("events:list", threadId),
  listSkills: () => ipcRenderer.invoke("skills:list"),
  listAgents: () => ipcRenderer.invoke("agents:list"),
  send: (request) => ipcRenderer.invoke("turn:send", request),
  interrupt: (threadId) => ipcRenderer.invoke("turn:interrupt", threadId),
  respondPermission: (requestId, decision) => ipcRenderer.invoke("permission:respond", requestId, decision),
  getDiff: (projectId) => ipcRenderer.invoke("diff:get", projectId),
  browserAttached: (webContentsId) => ipcRenderer.invoke("browser:attached", webContentsId),
  browserPick: () => ipcRenderer.invoke("browser:pick"),
  terminalOpen: (id, cwd, cols, rows) => ipcRenderer.invoke("terminal:open", id, cwd, cols, rows),
  terminalWrite: (id, data) => ipcRenderer.send("terminal:write", id, data),
  terminalResize: (id, cols, rows) => ipcRenderer.send("terminal:resize", id, cols, rows),
  terminalClose: (id) => ipcRenderer.invoke("terminal:close", id),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  updateSettings: (patch) => ipcRenderer.invoke("settings:update", patch),
  setSecret: (name, value) => ipcRenderer.invoke("settings:secret", name, value),
  openDataFolder: () => ipcRenderer.invoke("app:open-data-folder"),
  updateStatus: () => ipcRenderer.invoke("app:update-status"),
  listLimits: () => ipcRenderer.invoke("limits:list"),
  listAllSkills: () => ipcRenderer.invoke("library:skills"),
  getSkillDetail: (name) => ipcRenderer.invoke("library:skill", name),
  listAgentCatalog: () => ipcRenderer.invoke("library:agents"),
  getMcp: (projectId) => ipcRenderer.invoke("mcp:get", projectId),
  saveMcpServer: (entry, previousName) => ipcRenderer.invoke("mcp:save", entry, previousName),
  removeMcpServer: (name) => ipcRenderer.invoke("mcp:remove", name),
  setMcpServerEnabled: (name, enabled) => ipcRenderer.invoke("mcp:enable", name, enabled),
  testMcpServer: (name) => ipcRenderer.invoke("mcp:test", name),
  revealPath: (path) => ipcRenderer.invoke("app:reveal", path),
  listEditors: () => ipcRenderer.invoke("editors:list"),
  openInEditor: (target, editor) => ipcRenderer.invoke("editors:open", target, editor),
  installUpdate: () => ipcRenderer.invoke("app:install-update"),
  onUpdate: (listener) => {
    const handler = (_e: Electron.IpcRendererEvent, update: LiveUpdate) => listener(update);
    ipcRenderer.on("unskilled:update", handler);
    return () => ipcRenderer.removeListener("unskilled:update", handler);
  },
};

contextBridge.exposeInMainWorld("unskilled", api);
