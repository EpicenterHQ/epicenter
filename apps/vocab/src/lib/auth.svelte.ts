import { fromAuth } from '@epicenter/auth/svelte';
import { auth as platformAuth } from './auth.js';

export const auth = fromAuth(platformAuth);
