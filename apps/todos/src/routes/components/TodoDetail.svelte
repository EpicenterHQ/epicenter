<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Checkbox } from '@epicenter/ui/checkbox';
	import { Input } from '@epicenter/ui/input';
	import { Textarea } from '@epicenter/ui/textarea';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import { rowStemOf } from '@epicenter/folder';
	import { withFileNewlines } from '@epicenter/folder/file-browser';
	import type { TodoFields } from '$lib/definition.js';
	import type { RowSession } from '@epicenter/svelte/edit-session';
	import type { Todos } from '$lib/todos.svelte.js';
	import SaveBar from '@epicenter/svelte/save-bar';
	import { confirmDelete, openItem } from './file-actions.js';
	import { FileNameBar } from '@epicenter/svelte/folder-ui';

	let {
		todos,
		session,
		onBack,
	}: {
		todos: Todos;
		/** The open todo. The parent keys this view by it. */
		session: RowSession<TodoFields>;
		/** Shown on narrow screens, where the list and the editor take turns. */
		onBack?: () => void;
	} = $props();

	/** Textareas report LF, so views show LF; the notes setter restores the file's convention. */
	const lf = (text: string) => text.replace(/\r\n?/g, '\n');
</script>

<section class="flex h-full min-h-0 flex-col overflow-y-auto" aria-label="Todo">
	<div class="flex shrink-0 items-center gap-2 border-b px-3 py-3 sm:px-4">
		{#if onBack}
			<Button variant="ghost" size="icon-sm" aria-label="Back to todos" onclick={onBack} {@attach (node: HTMLElement) => node.focus()}>
				<ArrowLeftIcon />
			</Button>
		{/if}
		<Checkbox
			aria-label="Done"
			disabled={session.locked}
			bind:checked={
				() => session.draft.fields.done,
				(done) => session.edit((row) => { row.fields.done = done; })
			}
		/>
		<Input
			class="flex-1 text-base font-medium"
			placeholder="Title"
			aria-label="Title"
			disabled={session.locked}
			bind:value={
				() => session.draft.fields.title,
				(title) => session.edit((row) => { row.fields.title = title; })
			}
		/>
		<Button size="sm" variant="outline" onclick={() => void openItem(todos, session.path, 'files')}>
			Open in Files
		</Button>
	</div>

	<SaveBar
		save={session.state}
		onRetry={() => session.retry()}
		onKeepMine={() => todos.keepMine(session)}
		onReloadTheirs={() => todos.reloadTheirs(session)}
	/>

	<div class="flex min-h-48 flex-1 flex-col px-3 py-3 sm:px-4">
		<Textarea
			class="min-h-0 flex-1 field-sizing-fixed resize-none"
			placeholder="Notes in Markdown"
			aria-label="Notes"
			disabled={session.locked}
			bind:value={
				() => lf(session.draft.body),
				(notes) => session.edit((row) => { row.body = withFileNewlines(notes, row.body); })
			}
		/>
	</div>

	<FileNameBar
		prefix="todos/"
		name={rowStemOf(todos.folder.tables.todos.name, session.path) ?? ''}
		suffix=".md"
		onRename={(next) => todos.rename(session.path, `${next}.md`)}
		onDelete={() => void confirmDelete(todos, session.path)}
	/>
</section>
