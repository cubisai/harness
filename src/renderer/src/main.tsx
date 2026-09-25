import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles/app.css";

async function boot(): Promise<void> {
  // The UI preview (npm run preview:ui) runs in a plain browser with a fake
  // backend; inside Electron the preload bridge is always there.
  if (!window.unskilled && import.meta.env.VITE_MOCK) {
    const { installMock } = await import("./mock");
    installMock();
  }
  document.documentElement.classList.add(`platform-${window.unskilled.platform}`);
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();
