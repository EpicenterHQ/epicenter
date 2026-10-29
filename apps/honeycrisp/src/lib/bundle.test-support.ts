/**
 * The page's root, the opener the page gives it, and the editor and notes
 * modules it loads. `bundle.test.ts` bundles this the way each build
 * resolves it.
 */
export { openBrowserRepository } from '@epicenter/repository/api/browser';
export { createNoteEditor } from './editor/note-editor.js';
export { createNotes } from './notes.svelte.js';
