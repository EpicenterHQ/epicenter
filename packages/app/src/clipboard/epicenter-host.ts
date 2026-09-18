import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import { createClipboard } from './contract.js';

/** The host's system clipboard; it works while the window is unfocused. */
export const clipboard = createClipboard({ readText, writeText });
