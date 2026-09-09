import { fromAuth } from '@epicenter/auth/svelte';
import { authClient } from '#platform/auth';

export const auth = fromAuth(authClient);
