<script lang="ts">
	import type { Account, AuthState } from '@epicenter/auth';
	import type { ReactiveAuthClient } from '@epicenter/auth/svelte';
	import { Loading } from '@epicenter/ui/loading';
	import { onMount, untrack, type Snippet } from 'svelte';
	import { provideConnectionScreen } from './connection-screen-context.js';
	import { attachDesktopClose } from './desktop-close.js';
	import SignInScreen from './sign-in-screen.svelte';

	let {
		auth,
		appName,
		noun,
		local = false,
		close,
		children,
	}: {
		auth: ReactiveAuthClient;
		appName: string;
		noun: string;
		/** Whispering can open its device-local App without an Account. */
		local?: boolean;
		/** Close the currently mounted session, including its UI producers. */
		close: () => Promise<void>;
		children: Snippet<[Account | null]>;
	} = $props();

	type View =
		| { status: 'session'; account: Account | null }
		| { status: 'connection' | 'closed' };
	function destination(state: AuthState): View {
		if (state.status !== 'signed-out')
			return { status: 'session', account: state.account };
		return local
			? { status: 'session', account: null }
			: { status: 'connection' };
	}
	let view = $state.raw<View>(untrack(() => destination(auth.state)));
	let choosingConnection = false;
	let terminal = false;
	let generation = 0;
	let draining: Promise<void> = Promise.resolve();
	let closeError = $state('');

	async function transition(next: View) {
		const attempt = ++generation;
		// The session quiesces its own UI. Keep it mounted until close succeeds:
		// a refusal (such as active recording) must leave its controls usable.
		// A second transition must still wait for the first captured session.
		closeError = '';
		try {
			const currentClose = close();
			const pending = Promise.all([draining, currentClose]).then(() => undefined);
			draining = pending.catch(() => {});
			await pending;
			if (attempt === generation) view = next;
		} catch (cause) {
			if (attempt === generation)
				closeError =
					cause instanceof Error ? cause.message : 'Could not close the app.';
			throw cause;
		}
	}

	function openConnection() {
		if (terminal || choosingConnection) return;
		choosingConnection = true;
		void transition({ status: 'connection' }).catch(() => {
			choosingConnection = false;
		});
	}
	provideConnectionScreen(openConnection);

	function resume() {
		if (terminal) return;
		choosingConnection = false;
		void transition(destination(auth.state)).catch(() => {});
	}
	function observe(state: AuthState) {
		if (terminal || choosingConnection) return;
		const next = destination(state);
		if (
			view.status === next.status &&
			(next.status !== 'session' ||
				(view.status === 'session' && next.account === view.account))
		)
			return;
		void transition(next).catch(() => {});
	}

	onMount(() => {
		const stopAuth = auth.onStateChange(observe);
		observe(auth.state);
		let stopped = false;
		let stopDesktop: (() => void) | undefined;
		void attachDesktopClose(async () => {
			terminal = true;
			try {
				await transition({ status: 'closed' });
			} catch (cause) {
				terminal = false;
				throw cause;
			}
		}).then((stop) => {
			if (stopped) stop();
			else stopDesktop = stop;
		}).catch((cause) => {
			closeError =
				cause instanceof Error ? cause.message : 'Could not listen for desktop closure.';
		});
		return () => {
			terminal = true;
			generation++;
			stopped = true;
			stopAuth();
			stopDesktop?.();
			void close().catch(() => {});
		};
	});
</script>

{#if view.status === 'session'}
	{#key view.account}
		{@render children(view.account)}
	{/key}
{:else if view.status === 'connection'}
	<SignInScreen
		{auth}
		{appName}
		{noun}
		onCancel={local || auth.state.status !== 'signed-out' ? resume : undefined}
	/>
{:else}
	<Loading class="h-dvh" label="Closing your {noun}…" />
{/if}
{#if closeError}
	<div class="fixed inset-x-0 bottom-0 z-50 border-t bg-background p-4 text-center" role="alert">
		<p>Could not finish closing {appName}. The server has not changed.</p>
		<p class="text-sm text-muted-foreground">{closeError}</p>
	</div>
{/if}
