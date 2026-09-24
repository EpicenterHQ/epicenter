import type { openPersonal } from '@epicenter/app/open';
import { createContext } from 'svelte';
import type { speechProfileDefinition } from '../data.js';

export type PersonalStore = Awaited<
	ReturnType<typeof openPersonal<typeof speechProfileDefinition>>
>;
export const [getPersonal, setPersonal] = createContext<PersonalStore>();
