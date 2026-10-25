import type { SvelteFolder } from '@epicenter/svelte/folder-next';
import { createContext } from 'svelte';
import type { HoneycrispTables } from './data.js';

/** The opened folder `<OpenFolder>` hands Honeycrisp, read reactively. */
export type NotesFolder = SvelteFolder<HoneycrispTables>;

export const [getFolder, setFolder] = createContext<NotesFolder>();
