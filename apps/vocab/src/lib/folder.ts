import type { SvelteFolder } from '@epicenter/svelte/folder-next';
import { createContext } from 'svelte';
import type { VocabTables } from './data.js';

export const [getFolder, setFolder] =
	createContext<SvelteFolder<VocabTables>>();
