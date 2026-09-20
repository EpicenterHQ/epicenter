import { createContext } from 'svelte';
import type { createDictation } from './state/dictation.svelte';
import type { createEntriesState } from './state/entries.svelte.js';
import type { InferenceCatalog } from '@epicenter/app-shell/inference-picker';

export type VocabSurface = {
	catalog: InferenceCatalog;
	dictation: ReturnType<typeof createDictation>;
	entries: ReturnType<typeof createEntriesState>;
};

export const [getVocabSurface, setVocabSurface] = createContext<VocabSurface>();
