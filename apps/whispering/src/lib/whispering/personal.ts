import type { openPersonal } from '@epicenter/app/open';
import { createContext } from 'svelte';
import type { whisperingDefinition } from '../data.js';

export type PersonalStore = Awaited<
	ReturnType<typeof openPersonal<typeof whisperingDefinition>>
>;
export const [getPersonal, setPersonal] = createContext<PersonalStore>();
