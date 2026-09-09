import type { Tauri } from './tauri.tauri.js';

export type { Tauri } from './tauri.tauri.js';

/** Browser pages have no host window, operating-system commands, or native IPC. */
export const tauri: Tauri | null = null;
