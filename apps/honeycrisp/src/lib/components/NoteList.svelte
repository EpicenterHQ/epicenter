<!--
	The notes the folder shown holds, matching the search: pinned first, then
	by when each was made, newest first. The note files that do not read as
	notes are listed above them in every folder, so one cannot go missing.
-->
<script lang="ts">
	import { describeIssues } from '@epicenter/definition/contract';
	import { Button } from '@epicenter/ui/button';
	import * as ContextMenu from '@epicenter/ui/context-menu';
	import { toast } from '@epicenter/ui/sonner';
	import PinIcon from '@lucide/svelte/icons/pin';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import { format } from 'date-fns';
	import { getDateLabel } from '$lib/date-label.js';
	import { byName, folderLabel, getHoneycrisp, newestFirst, type Note, noteLabel, shownIn } from '$lib/honeycrisp.svelte.js';
	import { previewText } from '$lib/note-source.js';
	import { confirmDeleteNote } from './delete-note.js';

	let { onCreate }: { onCreate: () => void } = $props();

	const app = getHoneycrisp();
	const { notes, folders } = app;

	const visible = $derived(notes.items.filter((note) => shownIn(app.filter, note)).toSorted(newestFirst));
	const selectedId = $derived(app.selected?.collection === 'notes' ? app.selected.id : undefined);

	const heading = $derived.by(() => {
		const id = app.filter.folderId;
		if (id === null) return 'All Notes';
		const folder = folders.get({ id });
		return folder === undefined ? 'Notes' : folderLabel(folder);
	});

	const groups = $derived.by(() => {
		const result: { label: string; notes: Note[] }[] = [];
		const push = (label: string, note: Note) => {
			const last = result.at(-1);
			if (last?.label === label) last.notes.push(note);
			else result.push({ label, notes: [note] });
		};
		for (const note of visible) if (note.pinned) push('Pinned', note);
		for (const note of visible) if (!note.pinned) push(getDateLabel(note.createdAt), note);
		return result;
	});

	async function report(action: string, written: Promise<{ error: { message: string } | null }>) {
		const { error } = await written;
		if (error !== null) toast.error(`Could not ${action}`, { description: error.message });
	}

	const open = (id: string) => app.open({ collection: 'notes', id });
</script>

<section class="flex h-full min-h-0 flex-col" aria-label="Notes">
	<div class="flex h-11 shrink-0 items-center justify-between border-b px-3">
		<div class="flex items-center gap-2">
			<h2 class="text-sm font-semibold">{heading}</h2>
			<span class="text-xs text-muted-foreground">{visible.length}</span>
		</div>
		<Button variant="ghost" size="icon-sm" tooltip="New note (⌘N)" aria-label="New note" onclick={onCreate}>
			<PlusIcon />
		</Button>
	</div>

	<div class="min-h-0 flex-1 overflow-y-auto p-2">
		{#if notes.invalid.length > 0}
			<section aria-label="Needs repair">
				<h3 class="px-2 pt-2 pb-1 text-xs font-medium text-destructive">Needs repair</h3>
				{#each notes.invalid as file (file.id)}
					<button
						class="flex w-full flex-col gap-0.5 rounded-lg px-3 py-2 text-left hover:bg-accent/40"
						class:bg-accent={selectedId === file.id}
						data-invalid={file.id}
						aria-current={selectedId === file.id ? 'true' : undefined}
						onclick={() => open(file.id)}
					>
						<span class="line-clamp-1 font-mono text-xs">{file.path}</span>
						<span class="line-clamp-2 text-xs text-muted-foreground">
							{file.text === null ? 'It is not text.' : describeIssues(file.issues)}
						</span>
					</button>
				{/each}
			</section>
		{/if}

		{#if visible.length === 0 && !notes.loading}
			<p class="p-6 text-center text-sm text-muted-foreground">
				{app.filter.query.trim() === '' ? 'No notes here yet. Press + to create one.' : 'No notes match.'}
			</p>
		{/if}

		<ul aria-label="Note list">
			{#each groups as group (group.label)}
				<li>
					<h3 class="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">{group.label}</h3>
					<ul>
						{#each group.notes as note (note.id)}
							<li data-id={note.id}>
								<ContextMenu.Root>
									<ContextMenu.Trigger>
										<button
											class="flex w-full flex-col gap-0.5 rounded-lg px-3 py-2 text-left hover:bg-accent/40"
											class:bg-accent={selectedId === note.id}
											data-note={note.id}
											aria-current={selectedId === note.id ? 'true' : undefined}
											onclick={() => open(note.id)}
										>
											<span class="flex items-start justify-between gap-2">
												<span class="line-clamp-1 text-sm font-medium">
													{#if note.pinned}<PinIcon class="mr-1 inline size-3 fill-current align-baseline" />{/if}
													{noteLabel(note)}
												</span>
												<span class="shrink-0 text-xs text-muted-foreground">
													{format(new Date(note.createdAt), 'h:mm a')}
												</span>
											</span>
											<span class="line-clamp-2 text-xs text-muted-foreground">{previewText(note.body) || 'No text'}</span>
										</button>
									</ContextMenu.Trigger>
									<ContextMenu.Content class="w-52">
										<ContextMenu.Item
											onSelect={() => void report('pin the note', notes.update({ id: note.id }, { pinned: !note.pinned }))}
										>
											{note.pinned ? 'Unpin' : 'Pin'}
										</ContextMenu.Item>
										<ContextMenu.Sub>
											<ContextMenu.SubTrigger>Move to folder</ContextMenu.SubTrigger>
											<ContextMenu.SubContent class="max-h-(--bits-menu-content-available-height) w-48 overflow-y-auto">
												<ContextMenu.Item
													onSelect={() => void report('move the note', notes.update({ id: note.id }, { folderId: undefined }))}
												>
													No folder
												</ContextMenu.Item>
												<ContextMenu.Separator />
												{#each folders.items.toSorted(byName) as folder (folder.id)}
													<ContextMenu.Item
														onSelect={() => void report('move the note', notes.update({ id: note.id }, { folderId: folder.id }))}
													>
														{folderLabel(folder)}
													</ContextMenu.Item>
												{/each}
											</ContextMenu.SubContent>
										</ContextMenu.Sub>
										<ContextMenu.Separator />
										<ContextMenu.Item variant="destructive" onSelect={() => confirmDeleteNote(app, { id: note.id, label: noteLabel(note) })}>
											Delete…
										</ContextMenu.Item>
									</ContextMenu.Content>
								</ContextMenu.Root>
							</li>
						{/each}
					</ul>
				</li>
			{/each}
		</ul>
	</div>
</section>
