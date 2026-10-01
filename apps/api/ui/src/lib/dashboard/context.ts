import { createContext } from 'svelte';
import type { createDashboardRuntime } from './runtime.js';

export const [getDashboard, setDashboard] =
	createContext<ReturnType<typeof createDashboardRuntime>>();
