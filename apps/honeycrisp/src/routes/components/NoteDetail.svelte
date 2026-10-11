<!--
	One open note, in its row session. Its title, folder, pin, rich text, and
	Source change the session's draft, and each change saves at once. The view
	is mounted once per session; the rich-text view remounts only when a read
	replaces the draft (a merge with a change made elsewhere, or the review's
	answer), so its undo history survives saves.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Input } from '@epicenter/ui/input';
	import { toast } from '@epicenter/ui/sonner';
	import { Textarea } from '@epicenter/ui/textarea';
	import * as Tabs from '@epicenter/ui/tabs';
	import HistoryIcon from '@lucide/svelte/icons/history';
	import PinIcon from '@lucide/svelte/icons/pin';
	import { withFileNewlines } from '@epicenter/folder/file-browser';
	import { wellFormed } from '@epicenter/folder';
	import type { RowSession } from '@epicenter/svelte/edit-session';
	import { folderLabel, type NoteFields } from '$lib/data.js';
	import { withBody } from '$lib/note-source.js';
	import type { Notes } from '$lib/notes.svelte.js';
	import { confirmDelete, openItem } from './file-actions.js';
	import NoteHistory from './NoteHistory.svelte';
	import RichEditor from './RichEditor.svelte';
	import SaveBar from '@epicenter/svelte/save-bar';

	let { notes, session }: { notes: Notes; session: RowSession<NoteFields> } = $props();

	const fields = $derived(session.draft.fields);
	const pinned = $derived(fields.pinned);
	/** The folder this note names. `null` is no folder; an id may be the empty string. */
	const folderId = $derived(fields.folderId);
	const deleted = $derived(typeof fields.deletedAt === 'string');

	/** Which view of the note shows. Switching saves nothing and discards nothing. */
	let tab = $state<'rich' | 'source'>('rich');
	let historyOpen = $state(false);

	/** Textareas report LF; the setter restores the file's own line endings. */
	const lf = (text: string) => text.replace(/\r\n?/g, '\n');

	function setBody(value: string) {
		const body = wellFormed(withFileNewlines(value, session.draft.body));
		if (body !== session.draft.body) session.edit((row) => withBody(row, body));
	}

	async function report(action: string, problem: Promise<string | undefined>) {
		const message = await problem;
		if (message) toast.error(`Could not ${action}`, { description: message });
	}

	/** A folder's option value. No folder is the empty value, so a folder id never is. */
	const optionOf = (id: string | null) => (id === null ? '' : `folder:${id}`);
	const idOf = (option: string) => (option === '' ? null : option.slice('folder:'.length));
</script>

<section class="flex h-full min-h-0 flex-col" aria-label="Note">
	<div class="flex items-center gap-2 border-b px-3 py-2">
		<Input
			class="flex-1 text-base font-medium"
			bind:value={
				() => session.draft.fields.title,
				(title) =>
					session.edit((row) => {
						row.fields.title = wellFormed(title);
					})
			}
			disabled={session.locked}
			placeholder="Title"
			aria-label="Title"
		/>
		<select
			class="h-9 max-w-40 rounded-md border bg-background px-2 text-sm"
			aria-label="Folder"
			value={optionOf(folderId)}
			disabled={session.locked}
			onchange={(event) => {
				const next = idOf(event.currentTarget.value);
				session.edit((row) => {
					row.fields.folderId = next;
				});
			}}
		>
			<option value="">No folder</option>
			{#each notes.folders as folder (folder.path)}
				<option value={optionOf(folder.stem)}>{folderLabel(folder)}</option>
			{/each}
			{#if folderId !== null && !notes.folders.some((folder) => folder.stem === folderId)}
				<option value={optionOf(folderId)}>{folderId} (missing)</option>
			{/if}
		</select>
		<Button
			variant={pinned ? 'secondary' : 'ghost'}
			size="icon-sm"
			aria-label={pinned ? 'Unpin' : 'Pin'}
			aria-pressed={pinned}
			tooltip={pinned ? 'Unpin' : 'Pin'}
			disabled={session.locked}
			onclick={() =>
				session.edit((row) => {
					row.fields.pinned = !row.fields.pinned;
				})}
		>
			<PinIcon class={pinned ? 'fill-current' : ''} />
		</Button>
		{#if notes.host.history}
			<Button
				variant="ghost"
				size="icon-sm"
				aria-label="History"
				tooltip="Git history of this note"
				onclick={() => (historyOpen = true)}
			>
				<HistoryIcon />
			</Button>
		{/if}
	</div>

	<SaveBar
		save={session.state}
		review={session.review}
		onRetry={() => session.retry()}
		onResolve={(choices) => notes.resolve(session, choices)}
	/>

	<Tabs.Root bind:value={tab} class="flex min-h-0 flex-1 flex-col">
		<Tabs.List class="mx-3">
			<Tabs.Trigger value="rich">Rich text</Tabs.Trigger>
			<Tabs.Trigger value="source">Source</Tabs.Trigger>
		</Tabs.List>
		<!-- The rich-text view stays mounted while Source shows, so its undo history
		     survives a look at the source that changes nothing. It remounts only
		     when a read replaces the draft. -->
		<Tabs.Content value="rich" forceMount class="min-h-0 flex-1">
			{#key session.generation}
				<RichEditor
					{session}
					focusRequest={notes.focusRequest}
					onOpenSource={() => (tab = 'source')}
					onRefuse={(reason) => toast.warning('That edit was not made', { description: reason })}
				/>
			{/key}
		</Tabs.Content>
		<Tabs.Content value="source" class="flex min-h-0 flex-1 flex-col">
			<div class="flex min-h-0 flex-1 flex-col p-3">
				<Textarea
					class="min-h-40 flex-1 resize-none font-mono text-xs"
					bind:value={() => lf(session.draft.body), setBody}
					disabled={session.locked}
					aria-label="Markdown source"
					spellcheck={false}
				/>
			</div>
		</Tabs.Content>
	</Tabs.Root>

	<div class="flex flex-wrap items-center gap-2 border-t px-4 py-2 text-xs text-muted-foreground">
		<code class="font-mono">{session.path}</code>
		<Button
			size="sm"
			variant="ghost"
			tooltip="Edit the whole file as text, including keys Honeycrisp does not show"
			onclick={() => void openItem(notes, session.path, 'text')}
		>
			Edit as file
		</Button>
		<div class="ml-auto flex items-center gap-1">
			{#if deleted}
				<Button
					size="sm"
					variant="outline"
					disabled={session.locked}
					onclick={() => void report('restore the note', notes.restoreNote(session.path))}
				>
					Restore
				</Button>
				<Button size="sm" variant="ghost-destructive" onclick={() => void confirmDelete(notes, session.path)}>
					Delete permanently
				</Button>
			{:else}
				<Button
					size="sm"
					variant="ghost-destructive"
					disabled={session.locked}
					onclick={() => void report('delete the note', notes.trashNote(session.path))}
				>
					Move to Recently Deleted
				</Button>
			{/if}
		</div>
	</div>
</section>

{#if notes.host.history && historyOpen}
	<NoteHistory
		history={notes.host.history}
		path={session.path}
		admitting={!session.locked}
		onUse={(source) => notes.useVersion(session, source)}
		bind:open={historyOpen}
	/>
{/if}
