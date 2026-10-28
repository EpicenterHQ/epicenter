import type { Repository } from '@epicenter/repository';
import type { RepositoryTab } from '@epicenter/repository/browser';
import { createContext } from 'svelte';
import type { honeycrispApp } from './data.js';

export type HoneycrispRepository = Repository<typeof honeycrispApp.definitions>;

/** This tab's hold on the Honeycrisp repository: open here, open in another tab, or moved away. */
export type HoneycrispTab = RepositoryTab<typeof honeycrispApp.definitions>;

export const [getRepository, setRepository] = createContext<HoneycrispRepository>();
