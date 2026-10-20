/**
 * The page's root, the opener the page gives it, and the store it builds.
 * `bundle.test.ts` bundles this the way each build resolves it; the opener
 * is what brings in the build's folder engine.
 */
export { openFolder } from '@epicenter/folder';
export { default as FolderApp } from '@epicenter/svelte/folder-app';
export { createCaptures } from './captures.svelte.js';
