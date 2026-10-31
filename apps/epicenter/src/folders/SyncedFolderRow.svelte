<script lang="ts">
	/**
	 * One synced folder: its name, where it syncs to, and its last round in
	 * the CLI's own words. Every action is the parent's, each one CLI call.
	 */
	import { Button } from '@epicenter/ui/button';
	import * as DropdownMenu from '@epicenter/ui/dropdown-menu';
	import * as Item from '@epicenter/ui/item';
	import { Spinner } from '@epicenter/ui/spinner';
	import type { SyncedFolder } from '../ui/bindings.gen';
	import { describeSync, remoteName, type SyncTone } from './synced-folders.ts';

	let {
		folder,
		now,
		busy,
		onSync,
		onShare,
		onForget,
	}: {
		folder: SyncedFolder;
		now: number;
		/** What the window is doing to this folder, said while it runs. */
		busy: string | undefined;
		onSync: () => void;
		onShare: () => void;
		onForget: () => void;
	} = $props();

	const line = $derived(describeSync(folder, now));

	const DOT = {
		synced: 'bg-emerald-500',
		waiting: 'bg-muted-foreground/40',
		retry: 'bg-amber-500',
		stopped: 'bg-destructive',
		problem: 'bg-destructive',
	} satisfies Record<SyncTone, string>;
</script>

<Item.Root size="sm" aria-label={folder.name}>
	<Item.Content class="min-w-0">
		<Item.Title class="w-full min-w-0">
			<span class="truncate">{folder.name}</span>
			<span class="truncate text-xs font-normal text-muted-foreground">
				{remoteName(folder.remote)}
			</span>
		</Item.Title>
		<Item.Description class="flex min-w-0 items-center gap-1.5" title={folder.path}>
			{#if busy !== undefined}
				<Spinner class="size-3" />
				<span role="status">{busy}</span>
			{:else}
				<span class="size-2 shrink-0 rounded-full {DOT[line.tone]}" aria-hidden="true"></span>
				<span data-tone={line.tone}>{line.label}</span>
			{/if}
		</Item.Description>
		{#if busy === undefined && line.detail !== null}
			<p
				class="line-clamp-3 text-xs wrap-anywhere {line.tone === 'stopped' || line.tone === 'problem'
					? 'text-destructive'
					: 'text-muted-foreground'}"
				title={line.detail}
			>
				{line.detail}
			</p>
		{/if}
	</Item.Content>
	<Item.Actions>
		<Button
			variant="ghost"
			size="sm"
			disabled={busy !== undefined || folder.problem !== null}
			onclick={onSync}
		>
			Sync now
		</Button>
		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				{#snippet child({ props })}
					<Button {...props} variant="ghost" size="sm" aria-label="More for {folder.name}">
						More
					</Button>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="end">
				<DropdownMenu.Item disabled={folder.remote === null} onclick={onShare}>
					Sharing…
				</DropdownMenu.Item>
				<DropdownMenu.Separator />
				<DropdownMenu.Item variant="destructive" onclick={onForget}>
					Stop syncing…
				</DropdownMenu.Item>
			</DropdownMenu.Content>
		</DropdownMenu.Root>
	</Item.Actions>
</Item.Root>
