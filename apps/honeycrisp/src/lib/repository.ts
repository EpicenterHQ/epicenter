import type { Repository } from '@epicenter/repository';
import { createContext } from 'svelte';
import type { honeycrispApp } from './data.js';

export type HoneycrispRepository = Repository<typeof honeycrispApp.definitions>;

export const [getRepository, setRepository] = createContext<HoneycrispRepository>();
