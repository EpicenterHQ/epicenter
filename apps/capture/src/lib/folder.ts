import type { captureTables } from '@epicenter/capture';
import type { SvelteFolder } from '@epicenter/svelte/folder-next';
import { createContext } from 'svelte';

export const [getFolder, setFolder] =
	createContext<SvelteFolder<typeof captureTables>>();
