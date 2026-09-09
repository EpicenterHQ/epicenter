<script lang="ts">
	import type { AuthClient } from '@epicenter/auth';
	import { fromSubscription } from '@epicenter/svelte';
	import { Button } from '@epicenter/ui/button';
	import { Loading } from '@epicenter/ui/loading';
	import { onMount, type Snippet } from 'svelte';
	import type { Departure } from './departure.js';
	import { provideConnectionScreen, provideSignOut } from './connection-screen-context.js';
	import { attachDesktopClose } from './desktop-close.js';
	import SignInScreen from './sign-in-screen.svelte';

	let { auth, departure, hasApp, appName, noun, children }: {
		auth: AuthClient;
		departure: Departure;
		hasApp: boolean;
		appName: string;
		noun: string;
		children: Snippet;
	} = $props();
	let nativeError = $state('');
	const status = fromSubscription(
		(update) => departure.onChange(update),
		() => departure.state,
	);
	provideConnectionScreen(() => {
		void departure.go(() => window.location.assign('/?connect')).catch(() => {});
	});
	provideSignOut(() => departure.go(async () => {
		const result = await auth.signOut();
		if (result.error) throw result.error;
		window.location.replace('/');
	}));
	onMount(() => {
		let stopped = false;
		let stopNative: (() => void) | undefined;
		void attachDesktopClose(departure.close).then((stop) => {
			if (stopped) stop();
			else stopNative = stop;
		}).catch((cause) => {
			nativeError = cause instanceof Error ? cause.message : 'Could not listen for application closure.';
		});
		return () => {
			stopped = true;
			stopNative?.();
			void departure.close().catch(() => {});
		};
	});
</script>

{#if nativeError}<p role="alert">{nativeError}</p>{/if}

{#if status.current.phase === 'open' || status.current.phase === 'checking'}
	{#if hasApp}
		{@render children()}
	{:else}
		<SignInScreen {auth} {appName} {noun}
			onCancel={new URLSearchParams(location.search).has('connect') ? () => location.replace('/') : undefined} />
	{/if}
{:else}
	<div class="flex h-dvh flex-col items-center justify-center gap-4">
		{#if status.current.phase !== 'failed' && status.current.phase !== 'retired'}
			<Loading label="Closing your {noun}…" />
		{:else}
			{#if departure.canRetryRetirement}
				<p>Could not finish updating your {noun}. Keep this window open and try again.</p>
				<Button onclick={() => { void departure.retryRetirement().catch(() => {}); }}>Try again</Button>
			{:else if departure.canReopen}
				<Button onclick={() => location.reload()}>Reopen {appName}</Button>
			{:else}
				<p>Could not finish saving. Keep this window open.</p>
			{/if}
		{/if}
	</div>
{/if}
{#if status.current.error !== null && !departure.canRetryRetirement}
	<div class="fixed inset-x-0 bottom-0 z-50 border-t bg-background p-4 text-center" role="alert">
		<p>{status.current.error instanceof Error ? status.current.error.message : `Could not finish closing ${appName}.`}</p>
	</div>
{/if}
