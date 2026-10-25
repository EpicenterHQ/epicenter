import type { SvelteFolder } from '@epicenter/svelte/folder-next';
import { createContext } from 'svelte';
import type { messagesTables } from './definition.js';

export const [getFolder, setFolder] =
	createContext<SvelteFolder<typeof messagesTables>>();
