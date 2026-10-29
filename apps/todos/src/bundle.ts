/** Todos' bundle (ADR-0694): its `mount`, which the shell calls with the open repository, the app's path and `navigate`. */
import { mountSvelte } from '@epicenter/svelte/app';
import type { manifest } from './definition.js';
import TodosApp from './TodosApp.svelte';

export const mount = mountSvelte<typeof manifest>(TodosApp);
