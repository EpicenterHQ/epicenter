import { getContext, setContext } from 'svelte';

const connectionScreen = Symbol('connection-screen');

/** The boot node closes its one app session before exposing account navigation. */
export function provideConnectionScreen(open: () => void) {
	setContext(connectionScreen, open);
}

/** Absent in surfaces that do not own an app session, such as the hosted account UI. */
export function getConnectionScreen(): (() => void) | undefined {
	return getContext(connectionScreen);
}
