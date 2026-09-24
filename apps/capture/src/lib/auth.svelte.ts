import { fromAuth } from '@epicenter/auth/svelte';
import { auth as client } from '#platform/auth';

export const auth = fromAuth(client);
