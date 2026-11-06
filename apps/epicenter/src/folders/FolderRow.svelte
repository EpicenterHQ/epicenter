<!--
	One folder in the Epicenter folder: its title (or its directory's name),
	its mark from the background sync (ADR-0788, ADR-0801, ADR-0807), its
	state, and who holds it, with what can be done to it. A folder not synced
	here shows the question of which folder it is (ADR-0822): the folders the
	person holds that it could be, with who holds each, one selected when it
	held exactly the files it had here; the person syncs it with one, or as a
	new folder. A folder whose sync would delete many files on the server
	asks whether to delete them there or bring them back.
-->
<script lang="ts">
	import type { FolderMark, HomeFolder } from '@epicenter/folder/platform';
	import { describeMembers } from '@epicenter/folder/platform';
	import { Button } from '@epicenter/ui/button';
	import * as DropdownMenu from '@epicenter/ui/dropdown-menu';
	import * as Item from '@epicenter/ui/item';
	import { Label } from '@epicenter/ui/label';
	import * as RadioGroup from '@epicenter/ui/radio-group';
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
		deletions: { glyph: '⚠', label: 'Waiting for you: files deleted here' },
		git: { glyph: '·', label: 'Kept by Git' },
		refused: { glyph: '✗', label: 'Not synced' },
	} satisfies Record<FolderMark['mark'], { glyph: string; label: string }>;

	const STATES = {
		local: 'On this computer only',
		synced: 'Synced',
		shared: 'Shared',
		git: 'Kept by Git, so Epicenter does not sync it',
	} satisfies Record<HomeFolder['state'], string>;

	const question = $derived(folder.question);
	/** The folder the person picked to sync this one with, or `new`. */
	let chosen = $state<string | undefined>(undefined);
	const picked = $derived(chosen ?? question?.preselected ?? question?.silent ?? undefined);
	const asks = $derived(question !== null && question.candidates.length > 0);
</script>

<Item.Root variant="outline" size="sm" class="flex-wrap">
	<Item.Media class="w-5 justify-center text-base">
		{#if mark}
			<Tooltip.Root>
				<Tooltip.Trigger aria-label={MARKS[mark.mark].label}>
					{MARKS[mark.mark].glyph}
				</Tooltip.Trigger>
				<Tooltip.Content>
					{MARKS[mark.mark].label}{#if mark.mark === 'conflict' || mark.mark === 'deletions'}: {mark.paths.join(', ')}{:else if mark.mark === 'refused'}: {mark.reason}{/if}
				</Tooltip.Content>
			</Tooltip.Root>
		{/if}
	</Item.Media>
	<Item.Content>
		<Item.Title>{folder.title ?? folder.name}</Item.Title>
		<Item.Description>
			{#if folder.title !== null && folder.title !== folder.name}{folder.name} ·
			{/if}{STATES[folder.state]}{#if folder.members}
				· {describeMembers(folder.members)}{/if}{#if folder.unlisted}
				· {folder.unlisted}{/if}
		</Item.Description>
	</Item.Content>
	<Item.Actions>
		{#if folder.state === 'local' && !asks && folders.account()}
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
				{#if folder.title === null && folder.state !== 'git'}
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

	{#if mark?.mark === 'deletions'}
		<div class="flex w-full flex-col gap-2 border-t pt-2" data-testid="deletions">
			<p>
				{mark.paths.length} files were deleted here that the server still has. If you did not mean to delete them (an older backup, a folder emptied), bring them back.
			</p>
			<div class="flex gap-2">
				<Button size="sm" onclick={() => folders.answerDeletions(folder, 'restore')}>Bring them back</Button>
				<Button size="sm" variant="outline" onclick={() => folders.answerDeletions(folder, 'push')}>
					Delete them on the server too
				</Button>
			</div>
		</div>
	{/if}

	{#if asks && question && folders.account()}
		<div class="flex w-full flex-col gap-2 border-t pt-2" data-testid="question">
			<p>Which folder is this? It is not synced on this computer yet.</p>
			<RadioGroup.Root bind:value={() => picked ?? '', (value) => (chosen = value)}>
				{#each question.candidates as candidate (candidate.folder.id)}
					<div class="flex items-center gap-2">
						<RadioGroup.Item value={candidate.folder.id} id="{folder.name}-{candidate.folder.id}" />
						<Label for="{folder.name}-{candidate.folder.id}" class="font-normal">
							{candidate.folder.title ?? 'Untitled folder'} · {describeMembers(candidate.folder.members)}
							<span class="text-muted-foreground">
								(same {candidate.matchedBy}{#if candidate.folder.id === question.preselected}, and the same files it had here{/if})
							</span>
						</Label>
					</div>
				{/each}
				<div class="flex items-center gap-2">
					<RadioGroup.Item value="new" id="{folder.name}-new" />
					<Label for="{folder.name}-new" class="font-normal">A new folder</Label>
				</div>
			</RadioGroup.Root>
			<div>
				<Button
					size="sm"
					disabled={picked === undefined || picked === ''}
					onclick={() =>
						folders.syncFirst(folder, picked === 'new' ? { create: true } : { join: picked as string })}
				>
					Sync
				</Button>
			</div>
		</div>
	{/if}
</Item.Root>
