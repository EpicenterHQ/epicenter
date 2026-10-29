/** Files' bundle (ADR-0694): its `mount`, which the shell calls with the open repository, the app's path and `navigate`. */
import { mountSvelte } from '@epicenter/svelte/app';
import FilesApp from './FilesApp.svelte';
import type { manifest } from './manifest.js';

export const mount = mountSvelte<typeof manifest>(FilesApp);
