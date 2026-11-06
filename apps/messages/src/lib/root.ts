/** The web build may fall back to Messages' fictional demo. */
import WebStartup from './Startup.svelte';
import type { Platform } from './platform.js';

export const Startup: Platform['Startup'] = WebStartup;
