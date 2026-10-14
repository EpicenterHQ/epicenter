/**
 * The Epicenter host leaf: Connect takes any Git URL; the person's own Git
 * and credentials reach it. There is no account and no `/sync` return.
 */
import RemoteUrlPicker from './RemoteUrlPicker.svelte';
import type { TodosConnect } from './types.js';

export const connect: TodosConnect = { Picker: RemoteUrlPicker };
