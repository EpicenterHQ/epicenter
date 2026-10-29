import type { Repository } from '@epicenter/repository';
import { createContext } from 'svelte';
import type { todosApp } from './definition.js';

/** The Todos repository as the views read it: one handle for the page's life, its reads tracked (`reactive`). */
export type TodosRepository = Repository<typeof todosApp.definitions>;

export const [getRepository, setRepository] = createContext<TodosRepository>();
