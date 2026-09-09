import { fromAuth } from '@epicenter/auth/svelte';
import { authClient } from './auth.js';

export const auth = fromAuth(authClient);
