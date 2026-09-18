<script lang="ts" generics="TOpened">
	import type { AuthStartup } from '@epicenter/auth';
	import { fromSubscription } from '@epicenter/svelte';
	import { Button } from '@epicenter/ui/button';
	import { Loading } from '@epicenter/ui/loading';
	import { onDestroy, onMount, type Snippet } from 'svelte';
	import type { Departure } from './departure.js';
	import { provideConnectionScreen, provideSignOut } from './connection-screen-context.js';
	import { attachDesktopClose } from './desktop-close.js';
	import SignInScreen from './sign-in-screen.svelte';
	import CannotOpenScreen from './cannot-open-screen.svelte';

	let props: {
		connectionHref?: string;
		homeHref?: string;
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
		(update) => props.departure.onChange(update),
		() => props.departure.state,
	);
	// Authentication capabilities are fixed for this App lifetime.
	// svelte-ignore state_referenced_locally
	if (!props.startup.auth?.state.account || props.startup.connectInstance || props.startup.signInLocation) {
		provideConnectionScreen(() => {
			void props.departure.go(() => window.location.assign(props.connectionHref ?? '/?connect')).catch(() => {});
		});
	}
	provideSignOut(() => props.departure.go(async () => {
		if (!props.startup.auth) return;
		const result = await props.startup.auth.signOut();
		if (result.error) throw result.error;
		window.location.replace(props.homeHref ?? '/');
	}));
	onDestroy(() => {
		void props.departure.close().catch(() => {});
	});

	onMount(() => {
		let stopped = false;
		let stopNative: (() => void) | undefined;
		void attachDesktopClose(props.departure.close).then((stop) => {
			if (stopped) stop();
			else stopNative = stop;
		}).catch((cause) => {
			nativeError = cause instanceof Error ? cause.message : 'Could not listen for application closure.';
		});
		return () => {
			stopped = true;
			stopNative?.();
		};
	});
</script>

{#if nativeError}<p role="alert">{nativeError}</p>{/if}

{#if status.current.phase === 'open' || status.current.phase === 'checking' || status.current.phase === 'opening-failed'}
	{#if props.opening}
		{#await props.opening}
			<Loading class="h-dvh" label="Opening your {props.noun}…" />
		{:then opened}
			{@render props.children(opened)}
		{:catch error}
			{@render props.openingFailure?.()}
			<CannotOpenScreen appName={props.appName} noun={props.noun} {error} />
		{/await}
	{:else}
		<SignInScreen startup={props.startup} appName={props.appName} noun={props.noun}
			onCancel={new URLSearchParams(location.search).has('connect') ? () => location.replace(props.homeHref ?? '/') : undefined} />
	{/if}
{:else}
	<div class="flex h-dvh flex-col items-center justify-center gap-4">
		{#if status.current.phase !== 'failed' && status.current.phase !== 'retired'}
			<Loading label="Closing your {props.noun}…" />
		{:else}
			<p>This application has stopped. Reload to open it again. Unsaved changes may be lost.</p>
			<Button onclick={() => location.reload()}>Reload {props.appName}</Button>
		{/if}
	</div>
{/if}
{#if status.current.error !== null && status.current.phase !== 'opening-failed'}
	<div class="fixed inset-x-0 bottom-0 z-50 border-t bg-background p-4 text-center" role="alert">
		<p>{status.current.error instanceof Error ? status.current.error.message : `Could not finish closing ${props.appName}.`}</p>
	</div>
{/if}
