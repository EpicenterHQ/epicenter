<script lang="ts">
	import type { TableWrites } from '@epicenter/folder/query';
	import { Checkbox } from '@epicenter/ui/checkbox';
	import * as Select from '@epicenter/ui/select';
	import { createMutation } from '@tanstack/svelte-query';
	import { useDebounce } from 'runed';
	import { onDestroy } from 'svelte';
	import { resultMutationOptions } from 'wellcrafted/query';
	import {
		commitText,
		displayOf,
		type FieldChange,
		type FieldColumn,
		failureText,
		fieldSet,
		type TextKind,
		textOf,
	} from './field-input';

	/**
	 * One field's editor in one row, chosen by its kind, with its own set
	 * mutation (ADR-0576). Each change sets this field on the row's file as it
	 * is now, or removes it, and keeps every field another window changed. A checkbox, a select, and a multi-select send at the click. A
	 * text editor holds what is typed and sends it a second after the last
	 * keystroke, on Enter or when it loses focus, and when it goes away;
	 * Escape puts back the stored value. Until the person types, and once the
	 * save of what was typed lands, the box shows the stored value. A row
	 * another window deleted takes no set (ADR-0576): the editor says so, and
	 * typed text goes to `onlost`, which offers it.
	 */
	let {
		column,
		stem,
		writes,
		value,
		multiline = false,
		onlost,
	}: {
		column: FieldColumn;
		/** The row this editor edits. The grid keys each editor by it. */
		stem: string;
		/** The table's writes; this editor sends through its `set`. */
		writes: TableWrites<Record<string, unknown>>;
		/** The stored value; `undefined` when the row leaves the field out. */
		value: unknown;
		/** Edit JSON in a tall box, as the row panel does. */
		multiline?: boolean;
		/** Keep text typed into a row deleted elsewhere, for the person to copy. */
		onlost: (where: string, text: string) => void;
	} = $props();

	// The grid keys each editor by its row: while it replaces one, the prop
	// may already read the next row, so a save sent as it goes away uses this.
	// svelte-ignore state_referenced_locally
	const row = stem;
	// svelte-ignore state_referenced_locally
	const field = column.name;
	// svelte-ignore state_referenced_locally
	const lose = onlost;
	const editor = $derived(column.editor);
	const setRow = createMutation(() =>
		resultMutationOptions({
			mutationKey: ['folder', 'set', field],
			mutationFn: ({ stem, fields }: { stem: string; fields: Record<string, unknown> }) =>
				writes.set(stem, fields),
		}),
	);

	/** Why what is typed is not saved: it does not parse, or its save failed. */
	let problem = $state<string | undefined>(undefined);
	/** The text typed and not yet saved; `undefined` shows the stored value. */
	let typed = $state<string>();

	/** Send `change` to this field, as the file is now; `text` is what was typed for it. */
	function send(change: FieldChange, text?: string, onSuccess?: () => void) {
		setRow.mutate(
			{ stem: row, fields: fieldSet(field, change) },
			{
				onSuccess: (written) => {
					if (written === null) {
						problem = 'This row was deleted elsewhere, so your edit was not saved.';
						if (text !== undefined) lose(`${field} of ${row}`, text);
						return;
					}
					problem = undefined;
					onSuccess?.();
				},
				onError: (error) => {
					problem = failureText(error);
				},
			},
		);
	}

	/** Send what is typed, once it parses as this field's value. */
	function sendTyped() {
		if (typed === undefined) return;
		const sent = typed;
		const outcome = commitText(column, sent);
		switch (outcome.kind) {
			case 'invalid':
				problem = outcome.message;
				return;
			case 'unchanged':
				problem = undefined;
				typed = undefined;
				return;
			case 'remove':
			case 'set':
				send(outcome, sent, () => {
					if (typed === sent) typed = undefined;
				});
		}
	}
	const sendLater = useDebounce(sendTyped, 1000);
	// runed's timer outlives the editor; send now instead.
	onDestroy(() => void sendLater.runScheduledNow());

	const BOX =
		'w-full min-w-24 rounded-md border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive dark:bg-input/30';

	const shown = $derived(typed ?? textOf(editor.kind as TextKind, value));

	function oninput(event: Event) {
		typed = (event.currentTarget as HTMLInputElement | HTMLTextAreaElement).value;
		void sendLater();
	}

	function onkeydown(event: KeyboardEvent) {
		const input = event.currentTarget as HTMLInputElement | HTMLTextAreaElement;
		if (event.key === 'Escape') {
			problem = undefined;
			typed = undefined;
			input.blur();
		}
		// A multiline box takes Enter as a new line; it saves when it loses focus.
		if (event.key === 'Enter' && input instanceof HTMLInputElement) input.blur();
	}

	const onblur = () => void sendLater.runScheduledNow();

	/** The menu item that clears an optional select; no option is a NUL character. */
	const NONE = '\u0000';
	const selected = $derived(
		editor.kind === 'select' && typeof value === 'string' ? value : '',
	);
	const chosen = $derived(
		Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [],
	);

	function toggle(option: string) {
		if (editor.kind !== 'multiSelect') return;
		const next = chosen.includes(option)
			? chosen.filter((v) => v !== option)
			: editor.options.filter((o) => o === option || chosen.includes(o));
		send({ kind: 'set', value: next });
	}
</script>

{#if editor.kind === 'boolean'}
	<Checkbox
		checked={value === true}
		aria-label={column.name}
		onCheckedChange={(checked) => send({ kind: 'set', value: checked })}
	/>
{:else if editor.kind === 'select'}
	{@const options = editor.options}
	<Select.Root
		type="single"
		value={selected}
		onValueChange={(next) =>
			send(next === NONE ? { kind: 'remove' } : { kind: 'set', value: next })}
	>
		<Select.Trigger size="sm" class="w-full min-w-28" aria-label={column.name}>
			<span class="truncate">
				{value === undefined ? '' : displayOf(value)}
			</span>
		</Select.Trigger>
		<Select.Content>
			<Select.Group>
				{#if column.optional}
					<Select.Item value={NONE} label="None" />
				{/if}
				{#each options as option (option)}
					<Select.Item value={option} label={option} />
				{/each}
			</Select.Group>
		</Select.Content>
	</Select.Root>
{:else if editor.kind === 'multiSelect'}
	<div class="flex flex-wrap gap-1" role="group" aria-label={column.name}>
		{#each editor.options as option (option)}
			<button
				type="button"
				aria-pressed={chosen.includes(option)}
				onclick={() => toggle(option)}
				class={[
					'rounded-full border px-2 py-0.5 text-xs',
					chosen.includes(option)
						? 'border-primary bg-primary text-primary-foreground'
						: 'text-muted-foreground hover:bg-muted',
				]}
			>
				{option}
			</button>
		{/each}
	</div>
{:else if editor.kind === 'json' && multiline}
	<textarea
		class={[BOX, 'min-h-20 py-1.5 font-mono text-xs']}
		aria-label={column.name}
		aria-invalid={problem !== undefined}
		value={shown}
		{oninput}
		{onblur}
		{onkeydown}
	></textarea>
{:else}
	<input
		class={[
			BOX,
			'h-8',
			(editor.kind === 'number' ||
				editor.kind === 'integer' ||
				editor.kind === 'json') &&
				'font-mono',
		]}
		type={editor.kind === 'date' ? 'date' : editor.kind === 'url' ? 'url' : 'text'}
		inputmode={editor.kind === 'number' || editor.kind === 'integer'
			? 'decimal'
			: undefined}
		placeholder={editor.kind === 'tags'
			? 'a, b, c'
			: editor.kind === 'instant'
				? '2026-01-31T09:00:00.000Z'
				: editor.kind === 'datetime'
					? '2026-01-31T09:00:00Z'
					: undefined}
		autocomplete="off"
		aria-label={column.name}
		aria-invalid={problem !== undefined}
		value={shown}
		{oninput}
		{onblur}
		{onkeydown}
	/>
{/if}
{#if problem !== undefined}
	<p class="mt-1 text-xs text-destructive">{problem}</p>
{/if}
