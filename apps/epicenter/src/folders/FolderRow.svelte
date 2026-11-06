<!--
	One folder in the Epicenter folder: its title (or its directory's name),
	its mark from the background sync (ADR-0788, ADR-0801, ADR-0807), its
	state, and who holds it, with what can be done to it.
-->
<script lang="ts">
	import type { FolderMark, HomeFolder } from '@epicenter/folder/platform';
	import { describeMembers } from '@epicenter/folder/platform';
	import { Button } from '@epicenter/ui/button';
	import * as DropdownMenu from '@epicenter/ui/dropdown-menu';
	import * as Item from '@epicenter/ui/item';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import EllipsisIcon from '@lucide/svelte/icons/ellipsis';
	import { folders } from './home.svelte';

	let {
		folder,
		mark,
		onManage,
	}: {
		folder: HomeFolder;
		/** Its mark, while the app syncs; null signed out. */
		mark: FolderMark | null;
		onManage: () => void;
	} = $props();

	const MARKS = {
		synced: { glyph: '✓', label: 'Synced' },
		waiting: { glyph: '◌', label: 'Waiting to sync' },
		conflict: { glyph: '⚠', label: 'A note holds a conflict' },
		refused: { glyph: '✗', label: 'Not synced' },
	} satisfies Record<FolderMark['mark'], { glyph: string; label: string }>;

	const STATES = {
		local: 'On this computer only',
		synced: 'Synced',
		shared: 'Shared',
	} satisfies Record<HomeFolder['state'], string>;
</script>

<Item.Root variant="outline" size="sm">
	<Item.Media class="w-5 justify-center text-base">
		{#if mark}
			<Tooltip.Root>
				<Tooltip.Trigger aria-label={MARKS[mark.mark].label}>
					{MARKS[mark.mark].glyph}
				</Tooltip.Trigger>
				<Tooltip.Content>
					{MARKS[mark.mark].label}{#if mark.mark === 'conflict'}: {mark.paths.join(', ')}{:else if mark.mark === 'refused'}: {mark.reason}{/if}
				</Tooltip.Content>
			</Tooltip.Root>
		{/if}
	</Item.Media>
	<Item.Content>
		<Item.Title>{folder.title ?? folder.name}</Item.Title>
		<Item.Description>
			{#if folder.title !== null && folder.title !== folder.name}{folder.name} ·
			{/if}{#if folder.copyOf !== null}A copy of another folder, kept on this computer{:else}{STATES[folder.state]}{/if}{#if folder.members}
				· {describeMembers(folder.members)}{/if}{#if folder.unlisted}
				· {folder.unlisted}{/if}
		</Item.Description>
	</Item.Content>
	<Item.Actions>
		{#if folder.state === 'local' && folder.copyOf === null && folders.account()}
			<Button size="sm" variant="outline" onclick={() => folders.syncFirst(folder)}>
				Sync
			</Button>
		{/if}
		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				{#snippet child({ props })}
					<Button {...props} variant="ghost" size="icon-sm" aria-label="Actions for {folder.title ?? folder.name}">
						<EllipsisIcon />
					</Button>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="end" class="w-48">
				{#if folder.folder !== null}
					<DropdownMenu.Item onSelect={onManage}>Share and apps…</DropdownMenu.Item>
				{/if}
				{#if folder.title === null}
					<DropdownMenu.Item onSelect={() => folders.init(folder)}>
						Add epicenter.json
					</DropdownMenu.Item>
				{/if}
				<DropdownMenu.Item onSelect={() => navigator.clipboard.writeText(folder.path)}>
					Copy its path
				</DropdownMenu.Item>
			</DropdownMenu.Content>
		</DropdownMenu.Root>
	</Item.Actions>
</Item.Root>
