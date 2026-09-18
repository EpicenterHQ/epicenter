import { createContext } from 'svelte';
import type { createDictation } from './state/dictation.svelte';
import type { createEntriesState } from './state/entries.svelte.js';
import type { createVocabConnections } from './state/inference-connections.svelte';

export type VocabSurface = {
	inferenceConnections: ReturnType<typeof createVocabConnections>;
	dictation: ReturnType<typeof createDictation>;
	entries: ReturnType<typeof createEntriesState>;
};

export const [getVocabSurface, setVocabSurface] = createContext<VocabSurface>();
