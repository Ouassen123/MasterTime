import type { WindowApi } from '../shared/types';

declare global {
  interface Window {
    /** Surface IPC exposée par le preload (contextBridge — AD-1). */
    api: WindowApi;
  }
}

export {};
