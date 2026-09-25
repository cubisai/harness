import type { UnskilledApi } from "../../shared/types";

declare global {
  interface Window {
    unskilled: UnskilledApi;
  }
}

export const api = (): UnskilledApi => window.unskilled;
