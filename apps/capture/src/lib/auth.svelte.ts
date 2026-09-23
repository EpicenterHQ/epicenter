import { fromAuth } from '@epicenter/auth/svelte';
import { auth as client } from './auth.js';

export const auth = fromAuth(client);
