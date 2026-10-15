<script lang="ts">
	import { Checkbox } from '@epicenter/ui/checkbox';
	import * as Select from '@epicenter/ui/select';
	import {
		commitText,
		displayOf,
		type FieldChange,
		type FieldColumn,
		type TextKind,
		textOf,
	} from './field-input';

	/**
	 * One field's editor, chosen by its kind. Every commit saves at once
	 * through `commit`: a text editor commits on Enter or when it loses focus,
	 * and Escape puts back the stored value. A text editor calls `begin` at
	 * the first keystroke, which is when the row's draft captures the version
	 * the edit starts from; until then the box follows the stored value, even
	 * while focused. The other editors commit at the click that begins and
	 * ends their edit.
	 */
	let {
		column,
		value,
		begin,
		commit,
		revert,
		multiline = false,
	}: {
		column: FieldColumn;
		/** The stored value; `undefined` when the row leaves the field out. */
		value: unknown;
		/** Editing began: the first keystroke in a text editor. */
		begin: () => void;
		commit: (change: FieldChange) => void;
		/** The person put back what the box showed; nothing is saved. */
		revert: () => void;
		/** Edit JSON in a tall box, as the row panel does. */
		multiline?: boolean;
	} = $props();

	const editor = $derived(column.editor);
	let problem = $state<string | undefined>(undefined);
	let element = $state<HTMLInputElement | HTMLTextAreaElement | undefined>();
	/** The text the box showed when typing began: what an edit is measured from. */
	let shown = '';
	/** Whether the person typed since the box last showed the stored value. */
	let typing = false;

	const BOX =
		'w-full min-w-24 rounded-md border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive dark:bg-input/30';

	/** Put the stored value in the box. */
	function show(input: HTMLInputElement | HTMLTextAreaElement) {
		shown = textOf(editor.kind as TextKind, value);
		input.value = shown;
		typing = false;
	}

	// Follow the stored value until the person types: a read that lands
	// after that (another window's save) must not replace what they typed.
	$effect(() => {
		value;
		if (element !== undefined && !typing) show(element);
	});

	function oninput() {
		if (typing) return;
		typing = true;
		begin();
	}

	function finish(input: HTMLInputElement | HTMLTextAreaElement) {
		if (!typing) return;
		const text = input.value;
		if (text === shown) {
			problem = undefined;
			show(input);
			revert();
			return;
		}
		const outcome = commitText(column, text);
		switch (outcome.kind) {
			case 'invalid':
				problem = outcome.message;
				return;
			case 'unchanged':
				problem = undefined;
				show(input);
				revert();
				return;
			case 'remove':
			case 'set':
				problem = undefined;
				// The box keeps the text until the save lands and the stored value follows.
				typing = false;
				commit(
					outcome.kind === 'remove'
						? { kind: 'remove' }
						: { kind: 'set', value: outcome.value },
				);
		}
	}

	function onkeydown(event: KeyboardEvent) {
		const input = event.currentTarget as HTMLInputElement | HTMLTextAreaElement;
		if (event.key === 'Escape') {
			problem = undefined;
			if (typing) revert();
			show(input);
			input.blur();
		}
		// A multiline box takes Enter as a new line; it saves when it loses focus.
		if (event.key === 'Enter' && input instanceof HTMLInputElement) input.blur();
	}

	const onblur = (event: FocusEvent) =>
		finish(event.currentTarget as HTMLInputElement | HTMLTextAreaElement);

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
		commit({ kind: 'set', value: next });
	}
</script>

{#if editor.kind === 'boolean'}
	<Checkbox
		checked={value === true}
		aria-label={column.name}
		onCheckedChange={(checked) => commit({ kind: 'set', value: checked })}
	/>
{:else if editor.kind === 'select'}
	{@const options = editor.options}
	<Select.Root
		type="single"
		value={selected}
		onValueChange={(next) =>
			commit(next === NONE ? { kind: 'remove' } : { kind: 'set', value: next })}
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
		{oninput}
		{onblur}
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
		{oninput}
		{onblur}
		{onkeydown}
	/>
{/if}
{#if problem !== undefined}
	<p class="mt-1 text-xs text-destructive">{problem}</p>
{/if}
