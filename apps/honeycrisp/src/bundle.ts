/** Honeycrisp's bundle (ADR-0694): its `mount`, which the shell calls with the open repository, the app's path and `navigate`. */
import { mountSvelte } from '@epicenter/svelte/app';
import HoneycrispApp from './components/HoneycrispApp.svelte';
import type { manifest } from './data.js';

export const mount = mountSvelte<typeof manifest>(HoneycrispApp);
