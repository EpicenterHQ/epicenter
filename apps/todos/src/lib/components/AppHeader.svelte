<!--
	The header: the app's name, the two views (decision 76), "On this device"
	and, in a browser, "Synced", what the open one shows, and the account. The
	desktop window's folder is Epicenter's to sync, so it signs in to nothing
	and offers Open in Epicenter (`open-in-epicenter.ts`) instead of "Synced".
-->
<script lang="ts">
	import StatusPopover from '@epicenter/svelte/status-popover';
	import StatusRow from '@epicenter/svelte/status-row';
	import type { StatusLine } from '@epicenter/svelte/status-line';
	import { Button } from '@epicenter/ui/button';
	import { toast } from '@epicenter/ui/sonner';
	import { resolve } from '$app/paths';
	import { webAuth } from '$lib/auth.js';
	import { getTodos, type View } from '$lib/todos.js';
	import {
		currentShell,
		type HandoffStatus,
		openInEpicenter,
	} from '$lib/open-in-epicenter.js';

	const todos = getTodos();
	const auth = webAuth();
	let { view, pendingNewTodo }: { view: View; pendingNewTodo: boolean } = $props();

	const signedIn = $derived(auth !== null && auth.state.status !== 'signed-out');
	const status = $derived.by((): StatusLine => {
		if (pendingNewTodo) return { label: 'Todo not added', tone: 'warning' };
		if (view === 'device') {
			if (todos.error !== null)
				return {
					label: 'Not readable here',
					detail: todos.error.message,
					tone: 'error',
				};
			return { label: 'On this device', tone: 'neutral' };
		}
		if (auth?.state.status === 'reauth-required')
			return {
				label: 'Sign in again',
				detail: 'Sign in again to upload and to edit your repository.',
				tone: 'warning',
			};
		if (todos.error !== null)
			return {
				label: 'Offline',
				detail: todos.error.message,
				tone: 'warning',
			};
		return { label: 'Synced', tone: 'good' };
	});

	async function signIn() {
		if (auth === null) return;
		const { error } = await auth.startSignIn();
		if (error !== null)
			toast.error('Could not sign in', { description: error.message });
	}

	async function signOut() {
		if (auth === null) return;
		const { error } = await auth.signOut();
		if (error !== null)
			toast.error('Could not sign out', { description: error.message });
	}

	const shell = currentShell();
	let sending = $state(false);
	let handoff = $state<HandoffStatus>();

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
	{#if auth !== null}
		<nav class="flex items-center gap-1" aria-label="Views">
			<Button
				size="sm"
				variant={view === 'device' ? 'secondary' : 'ghost'}
				href={resolve('/')}
				aria-current={view === 'device' ? 'page' : undefined}
			>
				On this device
			</Button>
			<Button
				size="sm"
				variant={view === 'synced' ? 'secondary' : 'ghost'}
				href={resolve('/synced')}
				aria-current={view === 'synced' ? 'page' : undefined}
			>
				Synced
			</Button>
		</nav>
	{/if}
	<StatusPopover summary={status} details={[{ name: 'Status', testid: 'status-files', line: status }]}>
		<StatusRow name="Where">
			<span class="font-medium" data-testid="status-where">
				{auth === null ? 'This computer' : view === 'device' ? 'This browser' : 'Your repository'}
			</span>
			<span class="mt-0.5 block text-xs text-muted-foreground">
				{#if auth === null}
					Todos' folder on this computer. Add it in Epicenter to sync it.
				{:else if view === 'synced'}
					Your Epicenter repository, todos.
				{:else if signedIn}
					Kept in this browser until they upload to your repository on their own; then they are under Synced.
				{:else}
					Kept in this browser. Sign in and they upload to your Epicenter repository, under Synced.
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
		{#if shell !== undefined}
			<Button variant="outline" size="sm" disabled={sending} onclick={() => void send()}>
				Open in Epicenter
			</Button>
		{/if}
		{#if auth !== null}
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
