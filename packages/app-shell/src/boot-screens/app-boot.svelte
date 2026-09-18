<script lang="ts" generics="TDefinition extends DataDefinition">
	import type { DataDefinition } from '@epicenter/app';
	import { openApp, type App, type AppRuntime } from '@epicenter/app/open';
	import type { Account, AuthClient, BrowserAuth } from '@epicenter/auth';
	import { fromSubscription } from '@epicenter/svelte';
	import { Button } from '@epicenter/ui/button';
	import { Loading } from '@epicenter/ui/loading';
	import { onDestroy, onMount, tick, type Snippet } from 'svelte';
	import { createDeparture, type Departure } from './departure.js';
	import { provideConnectionScreen, provideSignOut } from './connection-screen-context.js';
	import { attachDesktopClose } from './desktop-close.js';
	import CannotOpenScreen from './cannot-open-screen.svelte';

	let props: {
		auth?: AuthClient;
		definition: TDefinition;
		runtime?: AppRuntime;
		selection?: BrowserAuth;
		/** The actual mounted component. close must return one idempotent drain. */
		ui?: { preflight?(): Promise<void>; close?(): void | Promise<void> };
		connectionHref?: string;
		homeHref?: string;
		appName: string;
		noun: string;
		openingFailure?: Snippet;
		children: Snippet<[App<TDefinition>, Departure['go'], Account | undefined]>;
	} = $props();
	// Svelte clears bind:this on removal; retain the actual owner until its drain ends.
	let ui: typeof props.ui;
	$effect.pre(() => { if (props.ui) ui = props.ui; });
	let nativeError = $state('');
	// svelte-ignore state_referenced_locally
	const account = props.auth?.getState().account;
	// svelte-ignore state_referenced_locally
	const opening = openApp(props.definition, { account, runtime: props.runtime });
	// These identities belong to this component instance. Changing accounts ends it.
	// svelte-ignore state_referenced_locally
	const departure = createDeparture({
		auth: props.auth,
		account,
		opening,
		async preflight() {
			// A native close can arrive before readiness. Mount the ready UI first
			// so its domain veto participates; opening failure is rendered by await.
			await opening.then(tick, () => {});
			await ui?.preflight?.();
		},
		async quiesce() {
			if (document.activeElement instanceof HTMLElement)
				document.activeElement.blur();
			// Capture the promise before Svelte clears bind:this during removal.
			const stopping = ui?.close?.();
			// Observe rejection immediately, even if it settles before tick.
			const removed = tick();
			await Promise.all([removed, stopping]);
		},
	});
	const status = fromSubscription(departure.onChange, departure.getState);
	// svelte-ignore state_referenced_locally
	if (!account || props.selection || !props.auth?.startSignIn) {
		provideConnectionScreen(() => {
			void departure.go(() => window.location.assign(props.connectionHref ?? '/?connect')).catch(() => {});
		});
	}
	provideSignOut(() => departure.go(async () => {
		if (!props.auth) return;
		const result = await props.auth.signOut();
		if (result.error) throw result.error;
		window.location.replace(props.homeHref ?? '/');
	}));

	onDestroy(() => {
		void departure.abandon().catch(() => {});
	});

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
		};
	});
</script>

{#if nativeError}<p role="alert">{nativeError}</p>{/if}

{#await opening}
	<Loading class="h-dvh" label="Opening your {props.noun}…" />
{:then opened}
	{#if status.current.phase === 'open'}
		{@render props.children(opened, departure.go, account)}
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
	{#if status.current.error !== null}
		<div class="fixed inset-x-0 bottom-0 z-50 border-t bg-background p-4 text-center" role="alert">
			<p>{status.current.error instanceof Error ? status.current.error.message : `Could not finish closing ${props.appName}.`}</p>
		</div>
	{/if}
{:catch error}
	{@render props.openingFailure?.()}
	<CannotOpenScreen appName={props.appName} noun={props.noun} {error} />
{/await}
