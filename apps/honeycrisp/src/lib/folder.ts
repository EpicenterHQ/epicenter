import type { FolderContext } from '@epicenter/svelte/folder';
import { createContext } from 'svelte';
import type { honeycrispTables } from './data.js';

export const [getFolder, setFolder] =
	createContext<FolderContext<typeof honeycrispTables>>();
