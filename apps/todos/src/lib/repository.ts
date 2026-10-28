import type { Repository } from '@epicenter/repository';
import { createContext } from 'svelte';
import type { todosApp } from './definition.js';

export type TodosRepository = Repository<typeof todosApp.definitions>;

export const [getRepository, setRepository] = createContext<TodosRepository>();
