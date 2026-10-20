/**
 * The page's root, the opener the page gives it, and the editor and notes
 * modules it loads. `bundle.test.ts` bundles this the way each build
 * resolves it; the opener is what brings in the build's folder engine.
 */
export { openFolder } from '@epicenter/folder';
export { default as FolderApp } from '@epicenter/svelte/folder-app';
export { stateAfter } from './editor/rich-text.js';
export { createNotes } from './notes.svelte.js';
