import type { Folder } from '@epicenter/folder';
import type { FolderContext } from '@epicenter/svelte/folder';
import { createContext } from 'svelte';
import type { WhisperingTables } from './definition.js';
export type WhisperingFolder = Folder<WhisperingTables>;
/** Whispering's opened folder context, as `<FolderApp>` provides it. */
export type WhisperingContext = FolderContext<WhisperingTables>;
export const [getFolder, setFolder] = createContext<WhisperingContext>();
