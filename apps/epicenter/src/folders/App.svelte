<!--
	The Folders window (ADR-0816, ADR-0819): every folder in the Epicenter
	folder with its title, mark, state, and members; the shares waiting for
	the person; and the folders they hold that are not on this computer. It
	composes `@epicenter/folder/platform` (ADR-0817) and runs no CLI. Its
	page keeps running while the window is hidden, so the background sync
	(`home.svelte.ts`) keeps every folder in sync while Epicenter runs.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import * as Item from '@epicenter/ui/item';
	import { Loading } from '@epicenter/ui/loading';
	import * as SectionHeader from '@epicenter/ui/section-header';
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { commands } from '../ui/bindings.gen';
	import { auth, localSettings, root } from './app';
	import FolderRow from './FolderRow.svelte';
	import { folders } from './home.svelte';
	import ManageFolder from './ManageFolder.svelte';

	let managing = $state<{ id: string; title: string } | null>(null);
	let manageOpen = $state(false);
	const home = $derived(folders.home());
</script>

<Tooltip.Provider>
	<main class="mx-auto flex max-w-3xl flex-col gap-6 p-6 text-sm">
		<header class="flex items-center justify-between gap-4">
			<div>
				<h1 class="text-xl font-semibold tracking-tight">Folders</h1>
				<p class="text-muted-foreground">{root.path || 'Your Epicenter folder'}</p>
			</div>
			<div class="flex gap-2">
				{#if folders.account()}
					<Button variant="outline" disabled={folders.sync()?.syncing} onclick={() => folders.syncNow()}>
						{folders.sync()?.syncing ? 'Syncing…' : 'Sync now'}
					</Button>
				{/if}
				<Button variant="ghost" onclick={() => commands.openHome()}>Settings</Button>
			</div>
		</header>

		{#if localSettings.state().status === 'open' && auth.state().status !== 'signed-in'}
			<Item.Root variant="muted">
				<Item.Content>
					<Item.Title>
						{auth.state().status === 'reauth-required' ? 'Sign in again to keep syncing' : 'Sign in to sync your folders'}
					</Item.Title>
					<Item.Description>
						Your folders stay on this computer. Signed in, Epicenter keeps each one in sync with your other devices and the people you share it with.
					</Item.Description>
				</Item.Content>
				<Item.Actions>
					<Button onclick={() => auth.startSignIn()}>Sign in</Button>
				</Item.Actions>
			</Item.Root>
		{/if}

		{#if folders.sync()?.last?.error}
			<p role="status" class="text-muted-foreground">Not syncing right now: {folders.sync()?.last?.error}</p>
		{/if}


		{#if home === null}
			{#if folders.homeError()}
				<p role="alert" class="text-destructive">{folders.homeError()}</p>
			{:else}
				<Loading />
			{/if}
		{:else}
			{#if folders.homeError()}
				<p role="status" class="text-muted-foreground">Members and shares are not shown: {folders.homeError()}</p>
			{/if}

			<section class="flex flex-col gap-2">
				{#each home.folders as folder (folder.path)}
					<FolderRow
						{folder}
						mark={folders.sync()?.marks.get(folder.path) ?? null}
						onManage={() => {
							if (folder.folder === null) return;
							managing = { id: folder.folder, title: folder.title ?? folder.name };
							manageOpen = true;
						}}
					/>
				{:else}
					<Empty.Root class="border">
						<Empty.Header>
							<Empty.Title>No folders yet</Empty.Title>
							<Empty.Description>
								Every folder in {root.path || 'your Epicenter folder'} shows here. Put one there, or link one from elsewhere.
							</Empty.Description>
						</Empty.Header>
					</Empty.Root>
				{/each}
				{#each home.unreadable as { name, reason } (name)}
					<p class="text-muted-foreground">{name}: {reason}</p>
				{/each}
			</section>

			{#if home.pending.length > 0}
				<section class="flex flex-col gap-2">
					<SectionHeader.Root>
						<SectionHeader.Title>Shared with you</SectionHeader.Title>
					</SectionHeader.Root>
					{#each home.pending as share (share.folder)}
						<Item.Root variant="outline" size="sm">
							<Item.Content>
								<Item.Title>{share.title ?? 'Untitled folder'}</Item.Title>
								<Item.Description>
									{#if share.from}From {share.from.name || share.from.email}, as{:else}As{/if} a {share.role}
								</Item.Description>
							</Item.Content>
							<Item.Actions>
								<Button size="sm" variant="ghost" onclick={() => folders.decline(share.folder)}>Decline</Button>
								<Button size="sm" onclick={() => folders.accept(share.folder, share.title)}>Accept</Button>
							</Item.Actions>
						</Item.Root>
					{/each}
				</section>
			{/if}

			{#if home.elsewhere.length > 0}
				<section class="flex flex-col gap-2">
					<SectionHeader.Root>
						<SectionHeader.Title>Yours, not on this computer</SectionHeader.Title>
					</SectionHeader.Root>
					{#each home.elsewhere as folder (folder.id)}
						<Item.Root variant="outline" size="sm">
							<Item.Content>
								<Item.Title>{folder.title ?? 'Untitled folder'}</Item.Title>
							</Item.Content>
							<Item.Actions>
								<Button size="sm" variant="outline" onclick={() => folders.clone(folder.id, folder.title)}>
									Bring here
								</Button>
							</Item.Actions>
						</Item.Root>
					{/each}
				</section>
			{/if}
		{/if}
	</main>
</Tooltip.Provider>

{#if managing}
	{#key managing.id}
		<ManageFolder bind:open={manageOpen} id={managing.id} title={managing.title} />
	{/key}
{/if}
<Toaster closeButton />
