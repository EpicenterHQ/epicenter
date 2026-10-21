import type { FolderContext } from '@epicenter/svelte/folder';
import { createContext } from 'svelte';
import type { messagesTables } from './definition.js';

export const [getFolder, setFolder] =
	createContext<FolderContext<typeof messagesTables>>();
