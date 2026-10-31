<!--
	A note that does not read, repaired as text: its text in a text area, what
	is wrong with the text as typed (checked against the contract with
	`checkContract`, so the person sees it before saving), and Save repair,
	which hands the text to `replace` (`ReactiveNotes.replace`, or a one list's)
	over the version the typing began from. `replace` refuses text that still
	does not fit (`Invalid`), and a note changed elsewhere since (`Conflict`);
	nothing is written then, and the typed text stays. After a `Conflict`,
	saving again replaces what is there now. A file that is not text has
	nothing to repair here.

	```svelte
	{#if invalid}
		<NoteRepair
			contract={todos}
			note={invalid}
			replace={(text, options) => list.replace({ id }, text, options)}
		/>
	{/if}
	```
-->
<script lang="ts">
	import {
		checkContract,
		type Contract,
		describeIssues,
		type Version,
	} from '@epicenter/definition/contract';
	import { Button } from '@epicenter/ui/button';
	import { Textarea } from '@epicenter/ui/textarea';
	import type { Result } from 'wellcrafted/result';

	let {
		contract,
		note,
		replace,
		onRepaired,
	}: {
		contract: Contract;
		/** The note as listed in `invalid`: its path, version, why it does not read, and its text (null when not UTF-8). */
		note: {
			path: string;
			version: Version;
			issues: readonly { field: string; message: string }[];
			text: string | null;
		};
		/** Replace the note with `text` over `over`, the version the repair was made from. */
		replace: (
			text: string,
			options: { over: Version },
		) => Promise<
			Result<
				unknown,
				{
					name?: string;
					message: string;
					issues?: readonly { field: string; message: string }[];
				}
			>
		>;
		/** Called once a repair landed. */
		onRepaired?: () => void;
	} = $props();

	/** The text as the person changed it; until then the note's. */
	let typed = $state<string | null>(null);
	/** The version the typing began from; until then (and after a clash) the note's as shown. */
	let over = $state<Version | null>(null);
	let saving = $state(false);
	let refused = $state<string | null>(null);

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

	async function save() {
		saving = true;
		refused = null;
		const { error } = await replace(text, { over: over ?? note.version });
		saving = false;
		if (error !== null) {
			if (error.name === 'Conflict') {
				// Saving again replaces what is there now, on purpose.
				over = null;
				refused =
					'it changed elsewhere since you began. Save repair again to replace it with this text.';
			} else
				refused =
					error.name === 'Invalid' && error.issues
						? describeIssues(error.issues)
						: error.message;
			return;
		}
		typed = null;
		over = null;
		onRepaired?.();
	}

	function type(value: string) {
		if (typed === null) over = note.version;
		typed = value;
	}

	function discard() {
		typed = null;
		over = null;
		refused = null;
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
				oninput={(event) => type(event.currentTarget.value)}
			/>
			{#if refused}<p class="text-xs text-destructive" role="alert">Not saved: {refused}</p>{/if}
			<div class="flex gap-2">
				<Button type="submit" size="sm" disabled={saving}>Save repair</Button>
				{#if typed !== null}
					<Button size="sm" variant="ghost" onclick={discard}>Discard</Button>
				{/if}
			</div>
		</form>
	{/if}
</div>
