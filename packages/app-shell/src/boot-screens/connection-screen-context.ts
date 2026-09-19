import { getContext, setContext } from 'svelte';

const connectionScreen = Symbol('connection-screen');
const signOut = Symbol('application-sign-out');

export function provideSignOut(action: () => Promise<void>) {
	setContext(signOut, action);
}

export function getSignOut(): (() => Promise<void>) | undefined {
	return getContext(signOut);
}

/** The boot node owns the warning and document or process replacement. */
export function provideConnectionScreen(open: () => void) {
	setContext(connectionScreen, open);
}

/** Absent in surfaces that do not own an app session, such as the hosted account UI. */
export function getConnectionScreen(): (() => void) | undefined {
	return getContext(connectionScreen);
}
