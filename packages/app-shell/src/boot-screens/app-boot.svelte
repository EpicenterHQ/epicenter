<script lang="ts" generics="THandle">
	import {
		isCallbackAuthClient,
		type Account,
		type AuthClient,
	} from '@epicenter/auth';
	import { Button } from '@epicenter/ui/button';
	import { Loading } from '@epicenter/ui/loading';
	import { onDestroy, onMount, tick, type Snippet } from 'svelte';
	import { confirmAccountChange } from './confirm-account-change.js';
	import {
		provideConnectionScreen,
		provideSignOut,
	} from './connection-screen-context.js';
	import CannotOpenScreen from './cannot-open-screen.svelte';

	let props: {
		auth?: AuthClient;
		open: ((signal: AbortSignal, account: Account | undefined) => Promise<THandle>) | undefined;
		signInHref: string;
		signedOutHref: string;
		appName: string;
		noun: string;
		openingFailure?: Snippet;
		children: Snippet<[THandle, Account | undefined]>;
	} = $props();

	const signingOut = new URL(location.href).searchParams.has('signout');
    const stopped = signingOut || new URL(location.href).searchParams.has('stopped');
	// This document captures its identity once. Recovery must not acquire an App.
	// svelte-ignore state_referenced_locally
	const account = props.auth?.getState().account;
	// svelte-ignore state_referenced_locally
	const acquire = stopped ? undefined : props.open;
	const startup = new AbortController();
	const opening = acquire
		? Promise.resolve().then(() => acquire(startup.signal, account))
		: undefined;
	let phase = $state<'open' | 'stopped'>(stopped ? 'stopped' : 'open');
	let error = $state('');
	let surface = $state<HTMLDivElement>();
	let changing = $state(false);
	let signingIn = false;
	let destroyed = false;
	let disposed = false;
    function retireWork() {
        if (disposed) return;
        disposed = true;
        startup.abort();
    }

	function stop() {
		if (surface) surface.inert = true;
		phase = 'stopped';
		retireWork();
	}

	async function recover() {
		stop();
		// Remove working UI and its normal tab-close warnings before navigation.
		await tick();
		if (destroyed) return;
		const url = new URL(location.href);
		url.searchParams.delete('connect');
		url.searchParams.set('stopped', '');
		location.replace(url);
	}

	// Deliberate sign-out owns navigation until its asynchronous auth work ends.
	// svelte-ignore state_referenced_locally
	const stopAuth = props.auth?.onStateChange((next) => {
		if (next.account !== account && phase === 'open') void recover();
	});

	provideConnectionScreen(() => {
		if (!props.auth || changing || signingIn || phase !== 'open') return;
		signingIn = true;
		changing = true;
		void (async () => {
			try {
				const confirmed = await confirmAccountChange(props.auth!);
				// The host can cancel a pending sign-in through explicit sign-out.
				changing = false;
				if (!confirmed || destroyed || phase !== 'open') return;
				if (isCallbackAuthClient(props.auth!)) {
					stop();
					await tick();
					if (destroyed) return;
					// Back must reach recovery even when the browser reloads this entry.
					const previous = new URL(location.href);
					previous.searchParams.set('stopped', '');
					history.replaceState(history.state, '', previous);
					location.assign(props.signInHref);
				} else {
					// OAuth cancellation keeps this working document alive.
					const result = await props.auth!.startSignIn();
					if (result.error) throw result.error;
				}
			} catch (cause) {
				if (!destroyed && phase === 'open')
					error = cause instanceof Error ? cause.message : 'Could not sign in.';
			} finally {
				signingIn = false;
			}
		})();
	});
	provideSignOut(async () => {
		if (!props.auth || changing || phase !== 'open') return;
		changing = true;
		try {
			if (
				!(await confirmAccountChange(props.auth!)) ||
				destroyed ||
				phase !== 'open'
			)
				return;
			stop();
			await tick();
			if (destroyed) return;
            if (isCallbackAuthClient(props.auth!)) {
                const destination = new URL(location.href);
                destination.searchParams.delete('connect');
                destination.searchParams.set('signout', '');
                destination.searchParams.set('stopped', '');
                location.replace(destination);
                return;
            }
			const result = await props.auth!.signOut();
			if (result.error) throw result.error;

		} finally {
			changing = false;
		}
	});

	onDestroy(() => {
		destroyed = true;
		stopAuth?.();
		retireWork();
	});
    onMount(() => {
        // This destination opens no roots. Credential clearing and bounded
        // revocation can settle even when the former working UI is gone.
        if (signingOut && props.auth && isCallbackAuthClient(props.auth)) {
            changing = true;
            void props.auth.signOut().then((result) => {
                if (result.error) throw result.error;
                if (!destroyed) location.replace(props.signedOutHref);
            }).catch((cause) => {
                error = cause instanceof Error ? cause.message : 'Could not sign out. Reload to retry.';
            }).finally(() => { changing = false; });
        }

		const restored = (event: PageTransitionEvent) => {
			if (event.persisted) void recover();
		};
		window.addEventListener('pageshow', restored);
        window.addEventListener('pagehide', stop);
        return () => {
            window.removeEventListener('pageshow', restored);
            window.removeEventListener('pagehide', stop);
        };
	});
</script>

{#if phase === 'open' && opening}
	<div class="contents" bind:this={surface}>
		{#await opening}
			<Loading class="h-dvh" label="Opening your {props.noun}…" />
		{:then opened}
			{@render props.children(opened, account)}
		{:catch cause}
			{@render props.openingFailure?.()}
			<CannotOpenScreen appName={props.appName} noun={props.noun} error={cause} />
		{/await}
	</div>
{:else}
	<div class="flex h-dvh flex-col items-center justify-center gap-4">
		<p>This application has stopped. Unsaved work may have been discarded.</p>
		<Button disabled={changing} onclick={() => {
			const url = new URL(location.href);
			url.searchParams.delete('stopped');
            url.searchParams.delete('signout');
			location.replace(url);
		}}>Reopen {props.appName}</Button>
	</div>
{/if}
{#if error}<p role="alert">{error}</p>{/if}
