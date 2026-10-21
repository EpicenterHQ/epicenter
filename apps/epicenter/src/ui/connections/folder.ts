import type { FolderContext } from '@epicenter/svelte/folder';
import { createContext } from 'svelte';
import type { connectionTables } from './connections.js';

export const [getFolder, setFolder] =
	createContext<FolderContext<typeof connectionTables>>();
