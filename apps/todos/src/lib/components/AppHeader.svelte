<!--
	The header: the app's name, where the todos are, and the account.
	Signed out, they are this browser's; signed in, they are the person's
	`todos` repository, and the ones made here signed out or offline count as
	"not uploaded yet" until they upload. The desktop window's folder is
	Epicenter's to sync, so it signs in to nothing; standalone Todos there
	offers Open in Epicenter (`open-in-epicenter.ts`).
-->
<script lang="ts">
	import StatusPopover from '@epicenter/svelte/status-popover';
	import StatusRow from '@epicenter/svelte/status-row';
	import type { StatusLine } from '@epicenter/svelte/status-line';
	import { Button } from '@epicenter/ui/button';
	import { toast } from '@epicenter/ui/sonner';
	import { onMount } from 'svelte';
	import { auth } from '$lib/auth.js';
	import { getTodos } from '$lib/context.js';
	import { isDesktop } from '$lib/device.js';
	import {
		currentShell,
		type HandoffStatus,
		offersOpenInEpicenter,
		openInEpicenter,
	} from '$lib/open-in-epicenter.js';

	const todos = getTodos();
	let { pendingNewTodo }: { pendingNewTodo: boolean } = $props();

	const signedIn = $derived(!isDesktop && auth.state.status !== 'signed-out');
	/** Signed in, the todos made here that have not reached the repository yet. */
	const waiting = $derived(
		todos.items.filter(({ where }) => where === 'device').length,
	);
	const status = $derived.by((): StatusLine => {
		if (pendingNewTodo) return { label: 'Todo not added', tone: 'warning' };
		if (todos.error !== null)
			return {
				label: 'Not reachable',
				detail: todos.error.message,
				tone: 'error',
			};
		if (!signedIn) return { label: 'On this device', tone: 'neutral' };
		if (auth.state.status === 'reauth-required')
			return {
				label: 'Uploads paused',
				detail: 'Sign in again to upload and to edit your repository.',
				tone: 'warning',
			};
		if (waiting > 0)
			return { label: `${waiting} not uploaded yet`, tone: 'busy' };
		return { label: 'In your repository', tone: 'good' };
	});

	async function signIn() {
		const { error } = await auth.startSignIn();
		if (error !== null)
			toast.error('Could not sign in', { description: error.message });
	}

	async function signOut() {
		const { error } = await auth.signOut();
		if (error !== null)
			toast.error('Could not sign out', { description: error.message });
	}

	const shell = currentShell();
	let offered = $state(false);
	let sending = $state(false);
	let handoff = $state<HandoffStatus>();

	onMount(() => {
		void offersOpenInEpicenter(shell).then((offers) => (offered = offers));
	});

	async function send() {
		if (shell === undefined) return;
		sending = true;
		handoff = undefined;
		handoff = await openInEpicenter(shell);
		sending = false;
	}
</script>

<header class="flex h-12 shrink-0 items-center gap-1.5 border-b px-2 sm:gap-2 sm:px-3">
	<!-- On narrow screens the list itself says what this is; the width goes to status. -->
	<h1 class="text-sm font-semibold max-sm:sr-only">Todos</h1>
	<StatusPopover summary={status} details={[{ name: 'Status', testid: 'status-files', line: status }]}>
		<StatusRow name="Where">
			<span class="font-medium" data-testid="status-where">
				{isDesktop ? 'This computer' : signedIn ? 'Your repository' : 'This browser'}
			</span>
			<span class="mt-0.5 block text-xs text-muted-foreground">
				{#if isDesktop}
					Todos' folder on this computer. Add it in Epicenter to sync it.
				{:else if signedIn}
					Your Epicenter repository, todos. Todos made here while signed out or offline upload on their own.
				{:else}
					Kept in this browser. Sign in to keep them in your Epicenter repository; these upload then.
				{/if}
			</span>
		</StatusRow>
	</StatusPopover>
	<div class="ml-auto flex min-w-0 items-center gap-2">
		{#if handoff !== undefined}
			<p
				role="status"
				class={[
					'min-w-0 truncate text-xs',
					handoff.tone === 'failed' ? 'text-destructive' : 'text-muted-foreground',
				]}
				title={handoff.message}
			>
				{handoff.message}
			</p>
		{/if}
		{#if offered}
			<Button variant="outline" size="sm" disabled={sending} onclick={() => void send()}>
				Open in Epicenter
			</Button>
		{/if}
		{#if !isDesktop}
			{#if auth.state.status === 'signed-out'}
				<Button size="sm" onclick={() => void signIn()}>Sign in</Button>
			{:else}
				{#if auth.state.status === 'reauth-required'}
					<Button size="sm" onclick={() => void signIn()}>Sign in again</Button>
				{/if}
				<Button variant="ghost" size="sm" onclick={() => void signOut()}>Sign out</Button>
			{/if}
		{/if}
	</div>
</header>
