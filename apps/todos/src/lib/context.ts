/**
 * Todos' state in Svelte context (decision 10). The device is set at the
 * root and is always there; the one list the views read and edit through
 * (`createTodoList`) is set where it is made: at the root signed out, and
 * under the signed-in subtree, one per account, with the repository in it.
 */
import type { Client } from '@epicenter/definition/contract';
import type { ReactiveClient } from '@epicenter/svelte/client';
import { createContext } from 'svelte';
import type { Todos } from './contract.js';
import type { TodoList } from './todos.js';

/** This page's device: its client (for the outbox and uploading) and that client as Svelte state. */
export type Device = {
	client: Client<Todos>;
	files: ReactiveClient<Todos>;
};

export const [getDevice, setDevice] = createContext<Device>();
export const [getTodos, setTodos] = createContext<TodoList>();
