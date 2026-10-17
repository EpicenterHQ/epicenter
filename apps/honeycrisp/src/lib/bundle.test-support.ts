/** The page's root and the editor and notes modules it loads. `bundle.test.ts` bundles this the way each build resolves it. */
export { default as FolderApp } from '@epicenter/svelte/folder-app';
export { stateAfter } from './editor/rich-text.js';
export { createNotes } from './notes.svelte.js';
