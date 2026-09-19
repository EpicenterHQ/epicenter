<script lang="ts" generics="TDefinition extends DataDefinition">
	import type { DataDefinition } from '@epicenter/app';
	import { openApp, type App, type AppRuntime } from '@epicenter/app/open';
	import type { Account, AuthClient } from '@epicenter/auth';
	import { Button } from '@epicenter/ui/button';
	import { Loading } from '@epicenter/ui/loading';
	import { onDestroy, onMount, tick, type Snippet } from 'svelte';
	import { createPageLifetime, type Leave } from './page-lifetime.svelte.js';
	import { provideAppCleanup } from './app-cleanup.js';
	import { provideConnectionScreen, provideSignOut } from './connection-screen-context.js';
	import { attachDesktopClose } from './desktop-close.js';
	import CannotOpenScreen from './cannot-open-screen.svelte';

	let props: {
		auth: AuthClient;
		definition: TDefinition;
		runtime?: AppRuntime;
		canChangeServer?: boolean;
		connectionHref: string;
		homeHref?: string;
		appName: string;
		noun: string;
		openingFailure?: Snippet;
		children: Snippet<[App<TDefinition>, Leave, Account | undefined]>;
	} = $props();
	const getCleanup = provideAppCleanup();
	let nativeError = $state('');
	// svelte-ignore state_referenced_locally
	const account = props.auth.getState().account;
	// svelte-ignore state_referenced_locally
	const opening = openApp(props.definition, { account, runtime: props.runtime });
	// These identities belong to this component instance. Changing accounts ends it.
	// svelte-ignore state_referenced_locally
	const lifetime = createPageLifetime({
		auth: props.auth,
		account,
		opening,
		async preflight(hasEnded) {
			// A native close can arrive before readiness. Mount the ready UI first
			// so its domain veto participates; opening failure is rendered by await.
			await opening.then(tick, () => {});
			if (hasEnded()) return;
			await getCleanup()?.preflight?.();
		},
		async stopUi(voluntary) {
			if (voluntary && document.activeElement instanceof HTMLElement)
				document.activeElement.blur();
			const stopping = getCleanup()?.close();
			// Observe rejection immediately, even if it settles before tick.
			const removed = tick();
			await Promise.all([removed, stopping]);
		},
	});
	// svelte-ignore state_referenced_locally
	if (!account || props.canChangeServer || !props.auth.startSignIn) {
		provideConnectionScreen(() => {
			void lifetime.go(() => window.location.assign(props.connectionHref)).catch(() => {});
		});
	}
	provideSignOut(() => lifetime.go(async () => {
		const result = await props.auth.signOut();
		if (result.error) throw result.error;
		window.location.replace(props.homeHref ?? '/');
	}));

	onDestroy(() => {
		void lifetime.abandon().catch(() => {});
	});

	onMount(() => {
		let stopped = false;
		let stopNative: (() => void) | undefined;
		void attachDesktopClose(lifetime.close).then((stop) => {
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

{#await opening}
	<Loading class="h-dvh" label="Opening your {props.noun}…" />
{:then opened}
	{#if lifetime.state.phase === 'open'}
		{@render props.children(opened, lifetime.go, account)}
	{:else}
		<div class="flex h-dvh flex-col items-center justify-center gap-4">
			{#if lifetime.state.phase === 'closing'}
				<Loading label="Closing your {props.noun}…" />
			{:else}
				{#if lifetime.state.phase === 'closed'}
					<p>Closed. Reload to open {props.appName} again.</p>
				{:else}
					<p>This application has stopped. Reload to open it again. Unsaved changes may be lost.</p>
				{/if}
				<Button onclick={() => location.reload()}>Reload {props.appName}</Button>
			{/if}
		</div>
	{/if}
	{#if lifetime.state.error !== null}
		<div class="fixed inset-x-0 bottom-0 z-50 border-t bg-background p-4 text-center" role="alert">
			<p>{lifetime.state.error instanceof Error ? lifetime.state.error.message : `Could not finish closing ${props.appName}.`}</p>
		</div>
	{/if}
{:catch error}
	{@render props.openingFailure?.()}
	<CannotOpenScreen appName={props.appName} noun={props.noun} {error} />
{/await}
