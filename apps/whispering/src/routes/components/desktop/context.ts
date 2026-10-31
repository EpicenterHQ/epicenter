/**
 * What the desktop app's pages share beside Whispering's state: the folder
 * the window keeps its files in, read once by the root.
 */
import { createContext } from 'svelte';

export type DesktopContext = {
	/** The folder's absolute path. */
	readonly folder: string;
};

export const [getDesktop, setDesktop] = createContext<DesktopContext>();
