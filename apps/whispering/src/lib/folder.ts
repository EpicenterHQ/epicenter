import type { SvelteFolder } from '@epicenter/svelte/folder-next';
import { createContext } from 'svelte';
import type { WhisperingTables } from './definition.js';
export type WhisperingFolder = SvelteFolder<WhisperingTables>;
export const [getFolder, setFolder] = createContext<WhisperingFolder>();
