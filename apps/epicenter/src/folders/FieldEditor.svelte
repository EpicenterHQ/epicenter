<script lang="ts">
	import { Checkbox } from '@epicenter/ui/checkbox';
	import * as Select from '@epicenter/ui/select';
	import {
		commitText,
		displayOf,
		type FieldColumn,
		type TextKind,
		textOf,
	} from './field-input';
	import type { FieldChange } from './row-edits';

	/**
	 * One field's editor, chosen by its kind. Every commit saves at once
	 * through `save`: a text editor commits on Enter or when it loses focus,
	 * and Escape puts back the stored value. Nothing is held as a draft.
	 * A text editor calls `begin` when it gains focus, so the save is merged
	 * against the row as it stood then; the other editors save at the click
	 * that begins and ends their edit.
	 */
	let {
		column,
		value,
		save,
		begin,
		multiline = false,
	}: {
		column: FieldColumn;
		/** The stored value; `undefined` when the row leaves the field out. */
		value: unknown;
		save: (change: FieldChange) => void;
		/** Editing began: a text editor gained focus. */
		begin: () => void;
		/** Edit JSON in a tall box, as the row panel does. */
		multiline?: boolean;
	} = $props();

	const editor = $derived(column.editor);
	let problem = $state<string | undefined>(undefined);
	let element = $state<HTMLInputElement | HTMLTextAreaElement | undefined>();
	/** The text the box held when it gained focus: what an edit is measured from. */
	let startText: string | undefined;

	const BOX =
		'w-full min-w-24 rounded-md border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive dark:bg-input/30';

	// Show the stored value, except in the box the person is typing in: a read
	// that lands meanwhile (focus, another window's save) must not replace it.
	$effect(() => {
		const text = textOf(editor.kind as TextKind, value);
		if (element !== undefined && document.activeElement !== element)
			element.value = text;
	});

	function onfocus() {
		startText = textOf(editor.kind as TextKind, value);
		begin();
	}

	function commit(text: string, input: HTMLInputElement | HTMLTextAreaElement) {
		const kind = editor.kind as TextKind;
		const stored = textOf(kind, value);
		// Measured from the text the edit began with: a read that landed
		// meanwhile changed `value`, not what the person typed over.
		if (text === (startText ?? stored)) {
			problem = undefined;
			input.value = stored;
			return;
		}
		const outcome = commitText(column, text);
		switch (outcome.kind) {
			case 'invalid':
				problem = outcome.message;
				return;
			case 'unchanged':
				problem = undefined;
				input.value = stored;
				return;
			case 'remove':
				problem = undefined;
				save({ kind: 'remove' });
				return;
			case 'set':
				problem = undefined;
				save({ kind: 'set', value: outcome.value });
		}
	}

	function onkeydown(event: KeyboardEvent) {
		const input = event.currentTarget as HTMLInputElement | HTMLTextAreaElement;
		if (event.key === 'Escape') {
			input.value = textOf(editor.kind as TextKind, value);
			problem = undefined;
			input.blur();
		}
		// A multiline box takes Enter as a new line; it saves when it loses focus.
		if (event.key === 'Enter' && input instanceof HTMLInputElement) input.blur();
	}

	const onchange = (event: Event) => {
		const input = event.currentTarget as HTMLInputElement | HTMLTextAreaElement;
		commit(input.value, input);
	};

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
		save({ kind: 'set', value: next });
	}
</script>

{#if editor.kind === 'boolean'}
	<Checkbox
		checked={value === true}
		aria-label={column.name}
		onCheckedChange={(checked) => save({ kind: 'set', value: checked })}
	/>
{:else if editor.kind === 'select'}
	{@const options = editor.options}
	<Select.Root
		type="single"
		value={selected}
		onValueChange={(next) =>
			save(next === NONE ? { kind: 'remove' } : { kind: 'set', value: next })}
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
		bind:this={element}
		class={[BOX, 'min-h-20 py-1.5 font-mono text-xs']}
		aria-label={column.name}
		aria-invalid={problem !== undefined}
		{onfocus}
		{onchange}
		{onkeydown}
	></textarea>
{:else}
	<input
		bind:this={element}
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
		{onfocus}
		{onchange}
		{onkeydown}
	/>
{/if}
{#if problem !== undefined}
	<p class="mt-1 text-xs text-destructive">{problem}</p>
{/if}
