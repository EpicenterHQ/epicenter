<!--
	A note that does not read, repaired as text: its text in a text area, what
	is wrong with the text as typed (checked against the contract with
	`checkContract`, so the person sees it before saving), and Save repair,
	which saves the text through the note's editor (`edit.text`). A save
	never fails: text that still does not read is written as typed and the
	note stays in `invalid()` with its new issues, and a change made
	elsewhere since the typing began is settled with it, as sync would
	(ADR-0774, ADR-0775). A file that is not text has nothing to repair here.

	```svelte
	{#if invalid}
		<NoteRepair contract={todos} note={invalid} edit={folder.todos.edit({ id })} />
	{/if}
	```
-->
<script lang="ts">
	import { checkContract, type Contract } from '@epicenter/definition/contract';
	import { Button } from '@epicenter/ui/button';
	import { Textarea } from '@epicenter/ui/textarea';

	let {
		contract,
		note,
		edit,
		onRepaired,
	}: {
		contract: Contract;
		/** The note as listed in `invalid`: its path, why it does not read, and its text (null when not UTF-8). */
		note: {
			path: string;
			issues: readonly { field: string; message: string }[];
			text: string | null;
		};
		/** The note's editor (`folder.<notes>.edit(args)`): its whole `text` is what a repair sets. */
		edit: { text: string; landed(): Promise<void> };
		/** Called once a repair has landed. */
		onRepaired?: () => void;
	} = $props();

	/** The text as the person changed it; until then the note's. */
	let typed = $state<string | null>(null);
	let saving = $state(false);

	const text = $derived(typed ?? note.text ?? '');
	/** What is wrong with the text as it stands, each with its line when it has one. */
	const problems = $derived(
		typed === null
			? note.issues.map(({ message }) => message)
			: (checkContract(contract, [{ path: note.path, text }]).data ?? []).map(
					({ line, message }) =>
						line === undefined ? message : `Line ${line}: ${message}`,
				),
	);

	/** Save the text as it stands; what is typed while it lands stays typed. A save the folder will not make (`FolderClosed`) keeps the typing. */
	async function save() {
		const saved = text;
		saving = true;
		edit.text = saved;
		try {
			await edit.landed();
		} catch {
			return;
		} finally {
			saving = false;
		}
		if (typed === saved) typed = null;
		onRepaired?.();
	}
</script>

<div class="flex min-h-0 flex-1 flex-col gap-2" data-testid="needs-repair">
	{#if note.text === null}
		<p class="text-sm">{note.path} is not text, so it cannot be repaired here.</p>
	{:else}
		{#if problems.length > 0}
			<ul class="list-inside list-disc text-xs text-muted-foreground" aria-label="Problems">
				{#each problems as problem}<li>{problem}</li>{/each}
			</ul>
		{:else}
			<p class="text-xs text-muted-foreground">This text reads. Save it to repair the note.</p>
		{/if}
		<form
			class="flex min-h-0 flex-1 flex-col gap-2"
			onsubmit={(event) => {
				event.preventDefault();
				void save();
			}}
		>
			<Textarea
				class="min-h-32 flex-1 field-sizing-fixed resize-none font-mono text-xs"
				aria-label="Text of {note.path}"
				value={text}
				oninput={(event) => (typed = event.currentTarget.value)}
			/>
			<div class="flex gap-2">
				<Button type="submit" size="sm" disabled={saving}>Save repair</Button>
				{#if typed !== null}
					<Button size="sm" variant="ghost" onclick={() => (typed = null)}>Discard</Button>
				{/if}
			</div>
		</form>
	{/if}
</div>
