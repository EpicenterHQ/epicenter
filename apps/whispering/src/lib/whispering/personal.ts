import type { openPersonal } from '@epicenter/app/open';
import type { speechProfileDefinition } from '../data.js';

export type PersonalStore = Awaited<
	ReturnType<typeof openPersonal<typeof speechProfileDefinition>>
>;
