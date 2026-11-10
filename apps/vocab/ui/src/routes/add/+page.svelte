<script lang="ts">
	import { goto } from '$app/navigation';
	import { Button } from '@epicenter/ui/button';
	import * as Field from '@epicenter/ui/field';
	import { Input } from '@epicenter/ui/input';
	import { toast } from '@epicenter/ui/sonner';
	import { Textarea } from '@epicenter/ui/textarea';
	import { langOf } from '$lib/text.js';
	import { app, hrefOf, vocab } from '$lib/vocab.svelte.js';

	const empty = { word: '', reading: '', meaning: '', body: '' };
	let draft = $state({ ...empty });
	let saving = $state(false);
	let wordInput = $state<HTMLInputElement | null>(null);

	async function add() {
		if (saving || !draft.word.trim()) return;
		saving = true;
		try {
			const added = await app.add(draft);
			const { word, path } = added;
			const open = { label: 'Open', onClick: () => goto(hrefOf(path)) };
			if (added.added) toast.success(`Added ${word}`, { action: open });
			else toast.info(`${word} is already saved`, { description: 'Nothing was changed.', action: open });
			draft = { ...empty };
			wordInput?.focus();
			void vocab.refresh();
		} catch (error) {
			toast.error(`${draft.word.trim()} was not added`, {
				description: error instanceof Error ? error.message : String(error),
			});
		} finally {
			saving = false;
		}
	}
</script>

<form
	class="mx-auto flex w-full max-w-2xl flex-col gap-5 p-4"
	onsubmit={(event) => {
		event.preventDefault();
		void add();
	}}
>
	<h1 class="text-2xl font-semibold">Add a word</h1>
	<Field.Group>
		<Field.Field>
			<Field.Label for="word">Word</Field.Label>
			<Input
				id="word"
				bind:ref={wordInput}
				bind:value={draft.word}
				lang={langOf(draft.word)}
				class="h-14 text-3xl md:text-3xl"
				autocomplete="off"
				autocapitalize="off"
				spellcheck="false"
				enterkeyhint="next"
				required
			/>
		</Field.Field>
		<Field.Field>
			<Field.Label for="reading">Reading</Field.Label>
			<Input
				id="reading"
				bind:value={draft.reading}
				placeholder="How it is read"
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
			<Field.Label for="examples">Examples</Field.Label>
			<Textarea id="examples" bind:value={draft.body} rows={3} placeholder="One per line" />
		</Field.Field>
	</Field.Group>
	<Button type="submit" class="h-12 text-base" disabled={saving || !draft.word.trim()}>
		{saving ? 'Adding…' : 'Add'}
	</Button>
</form>
