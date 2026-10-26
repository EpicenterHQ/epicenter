import type { SvelteFolder } from '@epicenter/svelte/folder';
import { createContext } from 'svelte';
import type { WhisperingTables } from './definition.js';
export type WhisperingFolder = SvelteFolder<WhisperingTables>;
export const [getFolder, setFolder] = createContext<WhisperingFolder>();
