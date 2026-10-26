import type { captureTables } from '@epicenter/capture';
import type { SvelteFolder } from '@epicenter/svelte/folder';
import { createContext } from 'svelte';

export const [getFolder, setFolder] =
	createContext<SvelteFolder<typeof captureTables>>();
