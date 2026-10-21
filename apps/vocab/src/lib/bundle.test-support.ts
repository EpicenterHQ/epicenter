/** The page's root, the opener it calls, and the store it builds. `bundle.test.ts` bundles this the way the build resolves it. */
export { openFolder } from '@epicenter/folder';
export { default as FolderApp } from '@epicenter/svelte/folder-app';
export { createVocab } from './vocab.svelte.js';
