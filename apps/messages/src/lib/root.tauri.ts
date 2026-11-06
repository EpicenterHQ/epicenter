/** The desktop build requires the local program started by its shell. */
import DesktopStartup from './DesktopStartup.svelte';
import type { Platform } from './platform.js';

export const Startup: Platform['Startup'] = DesktopStartup;
