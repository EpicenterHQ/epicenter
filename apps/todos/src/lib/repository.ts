import type { Repository } from '@epicenter/repository';
import type { RepositoryTab } from '@epicenter/repository/browser';
import { createContext } from 'svelte';
import type { todosApp } from './definition.js';

export type TodosRepository = Repository<typeof todosApp.definitions>;

/** This tab's hold on the Todos repository: open here, open in another tab, or moved away. */
export type TodosTab = RepositoryTab<typeof todosApp.definitions>;

export const [getRepository, setRepository] = createContext<TodosRepository>();
