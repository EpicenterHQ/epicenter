<!--
	One word: its fields and examples to edit, its review schedule, and, when
	its file has something that does not fit a word, a note quoting it. What is
	typed shows over the word as last read until Save sends it: the fields that
	changed through `set`, then the examples through `edit`, quoting the
	examples they were typed over, so examples changed elsewhere are never
	overwritten without saving again.
-->
<script lang="ts">
	import type { ActionError } from '@epicenter/app/client';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as Empty from '@epicenter/ui/empty';
	import * as Field from '@epicenter/ui/field';
	import { Input } from '@epicenter/ui/input';
	import { Loading } from '@epicenter/ui/loading';
	import { toast } from 'svelte-sonner';
	import { Textarea } from '@epicenter/ui/textarea';
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
	import { createMutation, createQuery } from '@tanstack/svelte-query';
	import { untrack } from 'svelte';
	import { reads, type Word, type WordChanges, writes } from './app.js';
	import { langOf, untilLabel } from './text.js';

	type Stage = NonNullable<Word['stage']>;
	const STAGES = {
		new: 'New',
		recognized: 'Recognize',
		understood: 'Understand',
		usable: 'Use',
	} satisfies Record<Stage, string>;

	let { path: given }: { path: string } = $props();
	// The route keys this page by its path, so it is fixed.
	const path = untrack(() => given);

	const word = createQuery(() => reads.get({ path }));
	const setWord = createMutation(() => writes.set);
	const editWord = createMutation(() => writes.edit);
	const deleteWord = createMutation(() => writes.delete);

	/** What is typed and not yet saved, field by field. */
	let draft = $state<{ reading?: string; meaning?: string; body?: string; stage?: Stage }>({});
	const saving = $derived(setWord.isPending || editWord.isPending);

	/**
	 * Only the fields typed differently from `saved`, so a save never writes
	 * back a value read earlier over one changed elsewhere since. A field
	 * emptied is removed.
	 */
	function changesOf(saved: Word) {
		const changes: WordChanges & { body?: string } = {};
		for (const field of ['reading', 'meaning'] as const) {
			const typed = draft[field]?.trim();
			if (typed !== undefined && typed !== (saved[field] ?? '')) changes[field] = typed === '' ? null : typed;
		}
		if (draft.stage !== undefined && draft.stage !== saved.stage) changes.stage = draft.stage;
		const typed = draft.body?.trim();
		const body = typed === undefined ? undefined : typed === '' ? '' : `${typed}\n`;
		if (body !== undefined && body !== saved.body) changes.body = body;
		return changes;
	}
	const isDirty = $derived(word.data !== undefined && Object.keys(changesOf(word.data)).length > 0);

	async function save() {
		const saved = word.data;
		if (!saved || saving) return;
		const { body, ...fields } = changesOf(saved);
		if (body === undefined && Object.keys(fields).length === 0) return;
		try {
			if (Object.keys(fields).length > 0) await setWord.mutateAsync({ path, ...fields });
			if (body !== undefined) await editWord.mutateAsync({ path, old: saved.body, new: body });
			draft = {};
			toast.success('Saved');
		} catch (error) {
			if ((error as ActionError).name === 'Changed') {
				// The fields are saved and the word read again; the examples typed stay, and saving again replaces what is there now.
				draft = { body: draft.body };
				toast.error('Examples not saved', {
					description: 'They changed elsewhere while you were editing. Your version is still in the box; save again to replace what is there now.',
				});
			} else toast.error('Not saved', { description: (error as ActionError).message });
		}
	}

	function confirmDelete(saved: Word) {
		confirmationDialog.open({
			title: `Delete ${saved.word}?`,
			description: 'Its meaning, examples, and review schedule are deleted. Your Epicenter’s history keeps a copy.',
			confirm: { text: 'Delete', variant: 'destructive' },
			onConfirm: async () => {
				await deleteWord.mutateAsync({ path });
				await goto(resolve('/words'));
			},
		});
	}

	const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
</script>

<div class="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 p-4">
	<Button variant="ghost" size="sm" class="-ml-2 self-start" href={resolve('/words')}>
		<ChevronLeftIcon />Words
	</Button>

	{#if word.isPending}
		<Loading class="flex-1" />
	{:else if !word.data && word.error?.name === 'Unreachable'}
		<Alert.Root variant="destructive">
			<Alert.Title>Vocab could not reach your Epicenter</Alert.Title>
			<Alert.Description>{word.error.message}</Alert.Description>
		</Alert.Root>
	{:else if !word.data}
		<Empty.Root>
			<Empty.Header>
				<Empty.Title>No word here</Empty.Title>
				<Empty.Description>
					{!word.error || word.error.name === 'Missing'
						? 'It was deleted, here or elsewhere.'
						: word.error.message}
				</Empty.Description>
			</Empty.Header>
			<Empty.Content><Button href={resolve('/words')}>All words</Button></Empty.Content>
		</Empty.Root>
	{:else}
		{@const saved = word.data}
		<form
			class="flex flex-col gap-5"
			onsubmit={(event) => {
				event.preventDefault();
				void save();
			}}
		>
			<h1 lang={langOf(saved.word)} class="text-5xl font-medium break-words">{saved.word}</h1>
			<Field.Group>
				<Field.Field>
					<Field.Label for="reading">Reading</Field.Label>
					<Input
						id="reading"
						bind:value={() => draft.reading ?? saved.reading ?? '', (value) => (draft.reading = value)}
						autocomplete="off"
						autocapitalize="off"
						spellcheck="false"
					/>
				</Field.Field>
				<Field.Field>
					<Field.Label for="meaning">Meaning</Field.Label>
					<Input
						id="meaning"
						bind:value={() => draft.meaning ?? saved.meaning ?? '', (value) => (draft.meaning = value)}
						autocomplete="off"
					/>
				</Field.Field>
				<Field.Field>
					<Field.Label for="examples">Examples and notes</Field.Label>
					<Textarea
						id="examples"
						lang={langOf(draft.body ?? saved.body)}
						bind:value={() => draft.body ?? saved.body, (value) => (draft.body = value)}
						rows={5}
						placeholder="One example per line"
					/>
				</Field.Field>
				<Field.Field>
					<Field.Label id="stage-label">How well you know it</Field.Label>
					<div class="flex flex-wrap gap-1" role="group" aria-labelledby="stage-label">
						{#each Object.entries(STAGES) as [stage, label] (stage)}
							{@const chosen = (draft.stage ?? saved.stage) === stage}
							<Button
								size="sm"
								variant={chosen ? 'default' : 'outline'}
								aria-pressed={chosen}
								onclick={() => (draft.stage = stage as Stage)}>{label}</Button
							>
						{/each}
					</div>
				</Field.Field>
			</Field.Group>
			<Button type="submit" class="h-12 text-base" disabled={!isDirty || saving}>
				{saving ? 'Saving…' : isDirty ? 'Save' : 'Saved'}
			</Button>
		</form>

		<dl class="grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg border p-4 text-sm">
			<dt class="text-muted-foreground">Next review</dt>
			<dd class="tabular-nums">
				{#if saved.due === undefined || Date.parse(saved.due) <= Date.now()}
					Due now
				{:else}
					In {untilLabel(saved.due, new Date())}, {dateFormat.format(new Date(saved.due))}
				{/if}
			</dd>
			<dt class="text-muted-foreground">Remembered in a row</dt>
			<dd class="tabular-nums">{saved.reps ?? 0}</dd>
			<dt class="text-muted-foreground">Interval</dt>
			<dd class="tabular-nums">{saved.interval ?? 0} days</dd>
			<dt class="text-muted-foreground">Ease</dt>
			<dd class="tabular-nums">{saved.ease ?? 2.5}</dd>
			{#if saved.createdAt}
				<dt class="text-muted-foreground">Added</dt>
				<dd>{dateFormat.format(new Date(saved.createdAt))}</dd>
			{/if}
		</dl>

		{#if saved.problems}
			<div class="text-xs text-muted-foreground" role="note">
				<p>Some of this word's file could not be read:</p>
				<ul class="mt-1 list-disc pl-4 font-mono break-words">
					{#each saved.problems as line (line)}
						<li>{line}</li>
					{/each}
				</ul>
			</div>
		{/if}

		<Button variant="destructive" class="self-start" onclick={() => confirmDelete(saved)}>
			Delete word
		</Button>
	{/if}
</div>
