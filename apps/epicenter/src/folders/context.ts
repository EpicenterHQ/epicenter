import type { FolderContext } from '@epicenter/svelte/folder';
import { createContext } from 'svelte';

export const [getFolder, setFolder] =
	createContext<FolderContext<Record<never, never>>>();
