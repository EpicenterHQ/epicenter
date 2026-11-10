<script lang="ts">
	import { changedElsewhere } from '@epicenter/app/client';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as Empty from '@epicenter/ui/empty';
	import * as Field from '@epicenter/ui/field';
	import { Input } from '@epicenter/ui/input';
	import { Loading } from '@epicenter/ui/loading';
	import { toast } from '@epicenter/ui/sonner';
	import { Textarea } from '@epicenter/ui/textarea';
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
	import { untrack } from 'svelte';
	import type { Word } from '../../../../../epicenter.js';
	import { langOf, pathOf, untilLabel, wordOf } from '$lib/text.js';
	import { app, vocab } from '$lib/vocab.svelte.js';

	type Stage = NonNullable<Word['stage']>;
	const STAGES = {
		new: 'New',
		recognized: 'Recognize',
		understood: 'Understand',
		usable: 'Use',
	} satisfies Record<Stage, string>;

	const key = $derived(page.params.word ?? '');
	const path = $derived(pathOf(key));

	/** The word as last read or saved, and what the form holds now. */
	let saved = $state.raw<Word>();
	let draft = $state({ reading: '', meaning: '', body: '', stage: undefined as Stage | undefined });
	let problem = $state<string>();
	let saving = $state(false);

	const isDirty = $derived(
		saved !== undefined &&
			(draft.reading !== (saved.reading ?? '') ||
				draft.meaning !== (saved.meaning ?? '') ||
				draft.body !== saved.body ||
				draft.stage !== saved.stage),
	);

	function show(word: Word) {
		saved = word;
		draft = {
			reading: word.reading ?? '',
			meaning: word.meaning ?? '',
			body: word.body,
			stage: word.stage,
		};
		problem = undefined;
	}

	// Read the word when the route names another, and again on each refresh unless there are unsaved edits.
	$effect(() => {
		const asked = path;
		vocab.refreshes();
		if (untrack(() => isDirty && saved?.path === asked)) return;
		if (untrack(() => saved?.path !== asked)) saved = undefined;
		app.get({ path: asked }).then(
			(found) => {
				if (asked === path) show(found);
			},
			(error: unknown) => {
				if (asked !== path) return;
				saved = undefined;
				problem = error instanceof Error ? error.message : String(error);
			},
		);
	});

	/**
	 * Only the fields that changed, so a save never writes back a value read
	 * earlier over one changed elsewhere since. A field emptied is removed.
	 */
	function changesOf(word: Word) {
		const changes: Omit<Parameters<typeof app.set>[0], 'path'> & { body?: string } = {};
		for (const field of ['reading', 'meaning'] as const) {
			const typed = draft[field].trim();
			if (typed !== (word[field] ?? '')) changes[field] = typed === '' ? null : typed;
		}
		if (draft.stage !== word.stage) changes.stage = draft.stage ?? null;
		const body = draft.body.trim() === '' ? '' : `${draft.body.trim()}\n`;
		if (body !== word.body) changes.body = body;
		return changes;
	}

	/**
	 * Saves the fields that changed with `set`, then the examples with `edit`,
	 * quoting them as loaded, so examples changed elsewhere are never
	 * overwritten without the person saving again.
	 */
	async function save() {
		if (!saved || saving) return;
		const { body, ...fields } = changesOf(saved);
		if (body === undefined && Object.keys(fields).length === 0) return;
		saving = true;
		let word = saved;
		try {
			if (Object.keys(fields).length > 0) word = await app.set({ path: word.path, ...fields });
			if (body !== undefined) word = await app.edit({ path: word.path, old: saved.body, new: body });
			show(word);
			toast.success('Saved');
			void vocab.refresh();
		} catch (error) {
			if (changedElsewhere(error)) {
				// The fields are saved; what was typed stays, and saving again replaces the examples now there.
				saved = await app.get({ path: word.path }).catch(() => word);
				toast.error('Examples not saved', {
					description: 'They changed elsewhere while you were editing. Your version is still in the box; save again to replace what is there now.',
				});
			} else
				toast.error('Not saved', {
					description: error instanceof Error ? error.message : String(error),
				});
		} finally {
			saving = false;
		}
	}

	function confirmDelete(path: string) {
		confirmationDialog.open({
			title: `Delete ${wordOf(path)}?`,
			description: 'Its meaning, examples, and review schedule are deleted. Your Epicenter’s history keeps a copy.',
			confirm: { text: 'Delete', variant: 'destructive' },
			onConfirm: async () => {
				await app.delete({ path });
				void vocab.refresh();
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

	{#if saved}
		<form
			class="flex flex-col gap-5"
			onsubmit={(event) => {
				event.preventDefault();
				void save();
			}}
		>
			<h1 lang={langOf(wordOf(saved.path))} class="text-5xl font-medium break-words">{wordOf(saved.path)}</h1>
			<Field.Group>
				<Field.Field>
					<Field.Label for="reading">Reading</Field.Label>
					<Input
						id="reading"
						bind:value={draft.reading}
						autocomplete="off"
						autocapitalize="off"
						spellcheck="false"
					/>
				</Field.Field>
				<Field.Field>
					<Field.Label for="meaning">Meaning</Field.Label>
					<Input id="meaning" bind:value={draft.meaning} autocomplete="off" />
				</Field.Field>
				<Field.Field>
					<Field.Label for="examples">Examples and notes</Field.Label>
					<Textarea id="examples" lang={langOf(draft.body)} bind:value={draft.body} rows={5} placeholder="One example per line" />
				</Field.Field>
				<Field.Field>
					<Field.Label id="stage-label">How well you know it</Field.Label>
					<div class="flex flex-wrap gap-1" role="group" aria-labelledby="stage-label">
						{#each Object.entries(STAGES) as [stage, label] (stage)}
							<Button
								size="sm"
								variant={draft.stage === stage ? 'default' : 'outline'}
								aria-pressed={draft.stage === stage}
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
			<dt class="text-muted-foreground">Added</dt>
			<dd>{dateFormat.format(new Date(saved.createdAt))}</dd>
		</dl>

		<Button variant="ghost-destructive" class="self-start" onclick={() => saved && confirmDelete(saved.path)}>
			Delete word
		</Button>
	{:else if problem}
		{#if problem.startsWith('There is no')}
			<Empty.Root>
				<Empty.Header>
					<Empty.Title lang={langOf(key)}>{key} is not saved</Empty.Title>
					<Empty.Description>It may have been deleted elsewhere.</Empty.Description>
				</Empty.Header>
				<Empty.Content><Button href={resolve('/words')}>All words</Button></Empty.Content>
			</Empty.Root>
		{:else}
			<Alert.Root variant="destructive">
				<Alert.Title>Vocab could not read {key}</Alert.Title>
				<Alert.Description>{problem}</Alert.Description>
			</Alert.Root>
		{/if}
	{:else}
		<Loading class="flex-1" />
	{/if}
</div>
