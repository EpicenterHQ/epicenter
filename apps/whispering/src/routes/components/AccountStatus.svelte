<!--
	The sign-in with Epicenter. Where the folder is the person's repository
	it holds the recordings, and the app asks for it before it opens
	(ADR-0786); where the folder is on this computer (`folder.reveal`) it is
	optional and grants Epicenter's models for transcription and AI alone,
	and a recording stays in the data folder either way.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { onMount } from 'svelte';
	import { account, folder } from '$lib/app.js';
	import { getWhispering } from '$lib/whispering.svelte.js';

	const whispering = getWhispering();
	const authState = $derived(account.state());
	let checking = $state(true);
	let problem = $state<string>();
	let busy = $state(false);
	let mounted = false;
	let checkId = 0;

	/** Whether the recordings are in the person's repository, which the sign-in holds. */
	const inRepository = folder.reveal === null;

	const describe = (cause: unknown) =>
		cause instanceof Error ? cause.message : String(cause);

	async function check() {
		const current = ++checkId;
		try {
			await account.refresh();
			if (!mounted || current !== checkId) return;
			problem = undefined;
		} catch (cause) {
			if (!mounted || current !== checkId) return;
			problem = describe(cause);
		} finally {
			if (mounted && current === checkId) checking = false;
		}
	}

	onMount(() => {
		mounted = true;
		void check();
		return () => {
			mounted = false;
			checkId++;
		};
	});

	async function signIn() {
		busy = true;
		const { error } = await account.startSignIn();
		if (error !== null) problem = error.message;
		busy = false;
	}

	async function signOut() {
		busy = true;
		const { error } = await account.signOut();
		if (error !== null) problem = error.message;
		busy = false;
	}
</script>

<svelte:window onfocus={() => void check()} />

<div class="flex flex-col gap-2 text-xs" data-testid="account-status">
	{#if checking}
		<p>Checking Epicenter sign-in…</p>
	{:else if authState.status === 'signed-in'}
		{#if inRepository}
			<p>Signed in to {new URL(authState.account.baseURL).host}. Your recordings are in your Epicenter repository, whispering, and this account also provides hosted transcription and AI.</p>
		{:else}
			<p>Signed in to {new URL(authState.account.baseURL).host}, for hosted transcription and AI. Your recordings stay in your data folder.</p>
		{/if}
	{:else if authState.status === 'reauth-required'}
		<p>Your Epicenter sign-in needs to be renewed before {inRepository ? 'your recordings are saved' : 'hosted transcription and AI work'} again.</p>
	{:else}
		<p>Optional: sign in to Epicenter for hosted transcription and AI. Your recordings stay in your data folder either way.</p>
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
