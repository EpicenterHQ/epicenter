import type { Repository } from '@epicenter/repository';
import { createContext } from 'svelte';
import type { honeycrispApp } from './data.js';

/** The Honeycrisp repository as the views read it: one handle for the page's life, its reads tracked (`reactive`). */
export type HoneycrispRepository = Repository<typeof honeycrispApp.definitions>;

export const [getRepository, setRepository] =
	createContext<HoneycrispRepository>();
