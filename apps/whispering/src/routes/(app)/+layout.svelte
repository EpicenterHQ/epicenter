<script lang="ts">
	import { beforeNavigate } from '$app/navigation';
	import { resolve } from '$app/paths';
	import {
		CannotOpenScreen,
		confirmAccountChange,
		provideConnectionScreen,
		provideSignOut,
	} from '@epicenter/app-shell/boot-screens';
	import { isCallbackAuthClient } from '@epicenter/auth';
	import { Loading } from '@epicenter/ui/loading';
	import { Button } from '@epicenter/ui/button';
	import { onDestroy, onMount, tick } from 'svelte';
	import { auth } from '#platform/auth';
	import { openWhisperingResources } from '$lib/whispering/resources.js';
	import WhisperingShell from './_components/WhisperingShell.svelte';

	let { children } = $props();

	// One mounted working layout captures one Account. Route changes retain it.
	const account = auth.getState().account;
	const signOut = () => auth.signOut();
	const startup = new AbortController();
	const opening = Promise.resolve().then(() =>
		openWhisperingResources(account, startup.signal),
	);
	let phase = $state<'open' | 'stopped'>('open');
	let error = $state('');
	let surface = $state<HTMLDivElement>();
	let changing = false;
	let signingIn = false;
	let destroyed = false;

	function stop() {
		if (phase === 'stopped') return;
		if (surface) surface.inert = true;
		phase = 'stopped';
		startup.abort();
	}

	async function leave(destination: string) {
		stop();
		await tick();
		if (!destroyed) location.replace(destination);
	}

	const unsubscribe = auth.onStateChange((next) => {
		if (next.account !== account && phase === 'open')
			void leave(resolve('/recovery'));
	});

	// A SvelteKit route change does not end this document or release its stores.
	beforeNavigate((navigation) => {
		if (
			!navigation.willUnload &&
			navigation.to &&
			!navigation.to.route.id?.startsWith('/(app)')
		) {
			navigation.cancel();
			void leave(navigation.to.url.href);
		}
	});

	provideConnectionScreen(() => {
		if (changing || signingIn || phase !== 'open') return;
		changing = true;
		signingIn = true;
		void (async () => {
			if (!(await confirmAccountChange(auth)) || destroyed || phase !== 'open') {
				changing = false;
				signingIn = false;
				return;
			}
			error = '';
			// Browser sign-in redirects; its callback installs the next Account in a
			// fresh document. Desktop acceptance restarts the host.
			// A native sign-in can be cancelled by sign-out while its handoff waits.
			const browser = isCallbackAuthClient(auth);
			if (!browser) changing = false;
			const result = await auth.startSignIn();
			signingIn = false;
			if (
				result.error &&
				phase === 'open' &&
				!destroyed &&
				(browser || !changing)
			) {
				error = result.error.message;
				if (browser) changing = false;
			}
			// Browser success launches navigation. Keep its guard until departure.
		})();
	});

	provideSignOut(async () => {
		if (changing || phase !== 'open') return;
		changing = true;
		if (!(await confirmAccountChange(auth)) || destroyed || phase !== 'open') {
			changing = false;
			return;
		}
		if (isCallbackAuthClient(auth)) {
			await leave(resolve('/auth/signout'));
			return;
		}
		stop();
		await tick();
		const result = await signOut();
		changing = false;
		if (result.error) throw result.error;
	});

	onDestroy(() => {
		destroyed = true;
		unsubscribe();
		stop();
	});

	onMount(() => {
		const restored = (event: PageTransitionEvent) => {
			if (event.persisted) void leave(resolve('/recovery'));
		};
		window.addEventListener('pagehide', stop);
		window.addEventListener('pageshow', restored);
		return () => {
			window.removeEventListener('pagehide', stop);
			window.removeEventListener('pageshow', restored);
		};
	});
</script>

{#if phase === 'open'}
	<div class="contents" bind:this={surface}>
		{#await opening}
			<Loading class="h-dvh" label="Opening your recordings…" />
		{:then openedApp}
			<WhisperingShell {openedApp} {account}>{@render children()}</WhisperingShell>
		{:catch cause}
			<CannotOpenScreen appName="Whispering" noun="recordings" error={cause} />
		{/await}
	</div>
{:else}
	<div class="flex h-dvh flex-col items-center justify-center gap-4">
		<p>This application has stopped. Unsaved work may have been discarded.</p>
		<Button onclick={() => location.replace(resolve('/recovery'))}>Recovery</Button>
	</div>
{/if}
{#if error}<p role="alert">{error}</p>{/if}
