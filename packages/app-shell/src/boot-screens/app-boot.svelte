<script lang="ts" generics="TOpened">
	import type { AuthStartup } from '@epicenter/auth';
	import { fromSubscription } from '@epicenter/svelte';
	import { Button } from '@epicenter/ui/button';
	import { Loading } from '@epicenter/ui/loading';
	import { onMount, type Snippet } from 'svelte';
	import type { Departure } from './departure.js';
	import { provideConnectionScreen, provideSignOut } from './connection-screen-context.js';
	import { attachDesktopClose } from './desktop-close.js';
	import SignInScreen from './sign-in-screen.svelte';
	import CannotOpenScreen from './cannot-open-screen.svelte';

	let { startup, departure, opening, appName, noun, openingFailure, children }: {
		startup: AuthStartup;
		departure: Departure;
		opening: Promise<TOpened> | undefined;
		appName: string;
		noun: string;
		openingFailure?: Snippet;
		children: Snippet<[TOpened]>;
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
		if (!startup.auth) return;
		const result = await startup.auth.signOut();
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

{#if status.current.phase === 'opening-failed'}
	{@render openingFailure?.()}
	<CannotOpenScreen {appName} {noun} error={status.current.error} />
{:else if status.current.phase === 'open' || status.current.phase === 'checking'}
	{#if opening}
		{#await opening}
			<Loading class="h-dvh" label="Opening your {noun}…" />
		{:then opened}
			{@render children(opened)}
		{:catch error}
			{@render openingFailure?.()}
			<CannotOpenScreen {appName} {noun} {error} />
		{/await}
	{:else}
		<SignInScreen {startup} {appName} {noun}
			onCancel={new URLSearchParams(location.search).has('connect') ? () => location.replace('/') : undefined} />
	{/if}
{:else}
	<div class="flex h-dvh flex-col items-center justify-center gap-4">
		{#if status.current.phase !== 'failed' && status.current.phase !== 'retired'}
			<Loading label="Closing your {noun}…" />
		{:else}
			<p>This application has stopped. Reload to open it again. Unsaved changes may be lost.</p>
			<Button onclick={() => location.reload()}>Reload {appName}</Button>
		{/if}
	</div>
{/if}
{#if status.current.error !== null && status.current.phase !== 'opening-failed'}
	<div class="fixed inset-x-0 bottom-0 z-50 border-t bg-background p-4 text-center" role="alert">
		<p>{status.current.error instanceof Error ? status.current.error.message : `Could not finish closing ${appName}.`}</p>
	</div>
{/if}
