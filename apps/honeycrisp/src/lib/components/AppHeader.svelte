<!--
	The header: the app's name, the two views (decision 76), "On this device"
	and "Synced", what the open one shows, and the account. The desktop app
	keeps its notes in a folder it chose (decision 81) and signs in to nothing:
	there the header has one view, says where the folder is and whether
	Epicenter syncs it, and offers "Sync with Epicenter" and "Choose folder…"
	(the desktop root's `DesktopFolder`).
-->
<script lang="ts">
	import StatusPopover from '@epicenter/svelte/status-popover';
	import StatusRow from '@epicenter/svelte/status-row';
	import type { StatusLine } from '@epicenter/svelte/status-line';
	import { Button } from '@epicenter/ui/button';
	import { LightSwitch } from '@epicenter/ui/light-switch';
	import { toast } from '@epicenter/ui/sonner';
	import { resolve } from '$app/paths';
	import { webAuth } from '$lib/auth.js';
	import { getDesktopFolder } from '$lib/desktop-context.js';
	import { getHoneycrisp, type View } from '$lib/honeycrisp.svelte.js';

	const { notes, folders } = getHoneycrisp();
	let { view }: { view: View } = $props();
	// A page's view is fixed for its life; the desktop root's never signs in.
	// svelte-ignore state_referenced_locally
	const desktop = view === 'desktop' ? getDesktopFolder() : null;
	const auth = desktop === null ? webAuth() : null;

	const signedIn = $derived(auth !== null && auth.state.status !== 'signed-out');
	const status = $derived.by((): StatusLine => {
		const unreadable = notes.error ?? folders.error;
		if (view === 'device' || desktop !== null) {
			if (unreadable !== null)
				return { label: 'Not readable here', detail: unreadable.message, tone: 'error' };
			if (desktop?.synced) return { label: 'Synced by Epicenter', tone: 'good' };
			return { label: desktop ? 'On this computer' : 'On this device', tone: 'neutral' };
		}
		if (auth?.state.status === 'reauth-required')
			return {
				label: 'Sign in again',
				detail: 'Sign in again to upload and to edit your repository.',
				tone: 'warning',
			};
		if (unreadable !== null) return { label: 'Offline', detail: unreadable.message, tone: 'warning' };
		return { label: 'Synced', tone: 'good' };
	});

	async function signIn() {
		if (auth === null) return;
		const { error } = await auth.startSignIn();
		if (error !== null) toast.error('Could not sign in', { description: error.message });
	}

	async function signOut() {
		if (auth === null) return;
		const { error } = await auth.signOut();
		if (error !== null) toast.error('Could not sign out', { description: error.message });
	}

	let asking = $state(false);
	async function syncWithEpicenter() {
		if (desktop === null) return;
		asking = true;
		await desktop.syncWithEpicenter();
		asking = false;
	}
</script>

<header class="flex h-12 shrink-0 items-center gap-2 border-b px-3">
	<h1 class="text-sm font-semibold max-sm:sr-only">Honeycrisp</h1>
	{#if desktop === null}
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
			{#if desktop !== null}
				<span class="font-medium" data-testid="status-where">This computer</span>
				<span class="mt-0.5 block text-xs break-all text-muted-foreground" data-testid="status-folder">
					{desktop.location ?? "Honeycrisp's folder"}
				</span>
				<span class="mt-0.5 block text-xs text-muted-foreground">
					{desktop.synced
						? 'Epicenter keeps its history and syncs it.'
						: 'Plain Markdown files. Sync with Epicenter to keep their history and use them elsewhere.'}
				</span>
				<Button class="mt-2" variant="outline" size="sm" onclick={() => void desktop.chooseFolder()}>
					Choose folder…
				</Button>
			{:else}
				<span class="font-medium" data-testid="status-where">{view === 'device' ? 'This browser' : 'Your repository'}</span>
				<span class="mt-0.5 block text-xs text-muted-foreground">
					{#if view === 'synced'}
						Your Epicenter repository, honeycrisp.
					{:else if signedIn}
						Kept in this browser until they upload to your repository on their own; then they are under Synced.
					{:else}
						Kept in this browser. Sign in and they upload to your Epicenter repository, under Synced.
					{/if}
				</span>
			{/if}
		</StatusRow>
	</StatusPopover>
	<div class="ml-auto flex min-w-0 items-center gap-1">
		{#if desktop?.request !== undefined}
			<p
				role="status"
				class={[
					'min-w-0 truncate text-xs',
					desktop.request.tone === 'failed' ? 'text-destructive' : 'text-muted-foreground',
				]}
				title={desktop.request.message}
			>
				{desktop.request.message}
			</p>
		{/if}
		<LightSwitch variant="ghost" />
		{#if desktop !== null}
			{#if desktop.synced === false}
				<Button variant="outline" size="sm" disabled={asking} onclick={() => void syncWithEpicenter()}>
					Sync with Epicenter
				</Button>
			{/if}
		{:else if auth !== null}
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
