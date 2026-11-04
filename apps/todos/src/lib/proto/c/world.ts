// PROTOTYPE option (c): the world as context, set where it is open.
import { createContext } from 'svelte';
import type { World } from '../open.js';

export const [getWorld, setWorld] = createContext<World>();
