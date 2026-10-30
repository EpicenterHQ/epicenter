/** The one host-owned account facade shared by Whispering's UI and requests. */
import { fromAuth } from '@epicenter/auth/svelte';
import type { PlatformAuth } from '../types.js';
import { createDesktopAccount } from './account.js';

let client: ReturnType<typeof createDesktopAccount> | undefined;
let auth: PlatformAuth | undefined;

function getClient() {
	return (client ??= createDesktopAccount());
}

export function getAuth(): PlatformAuth {
	return (auth ??= fromAuth(getClient()));
}

if (import.meta.hot) {
	import.meta.hot.dispose(() => client?.[Symbol.dispose]());
	import.meta.hot.accept(() => import.meta.hot?.invalidate());
}
