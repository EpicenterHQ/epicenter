import { fromAuth } from '@epicenter/auth/svelte';
import { auth as platformAuth } from '#platform/auth';

export const auth = fromAuth(platformAuth);
