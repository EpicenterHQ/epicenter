<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { onMount } from 'svelte';
	import { getAuth } from '#platform/auth';
	import { getWhispering } from '$lib/whispering.svelte.js';

	const whispering = getWhispering();
	const auth = getAuth();
	const authState = $derived(auth.state);
	let checking = $state(true);
	let problem = $state<string>();
	let busy = $state(false);
	let mounted = false;
	let checkId = 0;

	const describe = (cause: unknown) =>
		cause instanceof Error ? cause.message : String(cause);

	async function check() {
		const current = ++checkId;
		try {
			await auth.refresh();
			if (!mounted || current !== checkId) return;
			problem = undefined;
		} catch (cause) {
			if (!mounted || current !== checkId) return;
			problem = describe(cause);
		} finally {
			if (mounted && current === checkId) {
				checking = false;
				void whispering.readConnections();
			}
		}
	}

	onMount(() => {
		mounted = true;
		const stop = auth.onStateChange(() => {
			void whispering.readConnections();
		});
		void check();
		return () => {
			mounted = false;
			checkId++;
			stop();
		};
	});

	async function signIn() {
		busy = true;
		const { error } = await auth.startSignIn();
		if (error !== null) problem = error.message;
		busy = false;
	}

	async function signOut() {
		busy = true;
		const { error } = await auth.signOut();
		if (error !== null) problem = error.message;
		busy = false;
	}
</script>

<svelte:window onfocus={() => void check()} />

<div class="flex flex-col gap-2 text-xs" data-testid="account-status">
	{#if checking}
		<p>Checking Epicenter sign-in…</p>
	{:else if authState.status === 'signed-in'}
		<p>Signed in to {new URL(authState.account.baseURL).host}. Your recordings are kept in your whispering repository there.</p>
	{:else if authState.status === 'reauth-required'}
		<p>Your Epicenter sign-in needs to be renewed. Uploads wait until it is.</p>
	{:else}
		<p>Sign in to keep your recordings in your Epicenter repository and use hosted inference. What this browser holds uploads then.</p>
	{/if}
	{#if problem}
		<p class="text-destructive" role="alert">{problem}</p>
		<Button size="xs" variant="outline" class="self-start" onclick={() => void check()}>Check again</Button>
	{/if}
	{#if !checking}
		{#if authState.status === 'signed-in'}
			<Button size="xs" variant="outline" class="self-start" disabled={busy} onclick={() => void signOut()}>Sign out</Button>
		{:else}
			<Button size="xs" variant="outline" class="self-start" disabled={busy || whispering.recorder.phase !== 'idle'} onclick={() => void signIn()}>Sign in</Button>
			{#if whispering.recorder.phase !== 'idle'}<p>Finish recording before signing in.</p>{/if}
		{/if}
	{/if}
</div>
