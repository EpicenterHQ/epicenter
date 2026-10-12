<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Input } from '@epicenter/ui/input';
	import { Label } from '@epicenter/ui/label';
	import * as Popover from '@epicenter/ui/popover';
	import { tick, untrack } from 'svelte';
	import type { Entries } from '$lib/entries.svelte.js';
	import { capturePhrase, sourceHoldsPhrase } from '$lib/phrase-capture.js';

	// Saving a phrase from one saved tutor message. The conversation binds
	// `root` to its message list; this component owns every listener and the
	// one popover. A phrase comes from a selection made with the pointer, the
	// keyboard, or touch handles, or is typed after pressing a message's
	// `data-save-phrase` button. It is the message's own text, trimmed and
	// otherwise unchanged, saved as an entry with an empty note and the New
	// stage, both of which stay the learner's.
	let {
		root,
		entries,
		resetKey,
	}: {
		root: HTMLElement | null | undefined;
		entries: Entries;
		/** Changes when the conversation moves on; the open candidate is dropped. */
		resetKey: unknown;
	} = $props();

	/**
	 * How the popover was asked for. `selection` leaves focus where it is, so a
	 * native selection and its touch handles survive; `keyboard` and `button`
	 * move focus into the popover.
	 */
	type Via = 'selection' | 'keyboard' | 'button';
	type Candidate = {
		via: Via;
		messageId: string;
		message: HTMLElement;
		anchor: { getBoundingClientRect: () => DOMRect };
		/** The button to give focus back to. */
		opener?: HTMLElement;
	};

	let candidate = $state.raw<Candidate | undefined>();
	// The phrase: fixed by a selection, or typed after pressing the button.
	let text = $state('');
	let composing = $state(false);
	let open = $state(false);
	let pending = $state(false);
	let added = $state('');
	// The phrase the folder answered was already a saved word.
	let already = $state('');
	let problem = $state('');
	let content = $state<HTMLElement | null>(null);
	// Counts candidates, so an answer to an earlier one is not shown for this one.
	let ticket = 0;
	let touchedAt = 0;

	const phrase = $derived(text.trim());
	const typed = $derived(candidate?.via === 'button');
	const valid = $derived(
		candidate !== undefined &&
			phrase !== '' &&
			(!typed || sourceHoldsPhrase(candidate.message, phrase)),
	);
	// The list on screen never decides that a phrase is already saved: another
	// tab may have removed the word since it was read. Saving asks the folder,
	// which answers that the word is there or saves it.
	const blocked = $derived(!valid || pending);

	function focusInside() {
		if (content?.contains(document.activeElement)) return;
		content?.querySelector<HTMLElement>('input, button')?.focus();
	}

	function close() {
		open = false;
		ticket++;
	}

	function show(next: Candidate, selected: string) {
		const same =
			open &&
			candidate !== undefined &&
			!typed &&
			next.via !== 'button' &&
			candidate.messageId === next.messageId &&
			text === selected;
		if (!same) {
			text = selected;
			added = '';
			already = '';
			problem = '';
			ticket++;
		}
		// A selection that is being adjusted must not take over a popover the
		// keyboard already holds.
		candidate =
			same && candidate?.via === 'keyboard' ? { ...next, via: 'keyboard' } : next;
		open = true;
		// Opening focuses by itself; this covers a popover that was already open.
		if (candidate.via !== 'selection') void tick().then(focusInside);
	}

	async function add() {
		if (blocked || !candidate) return;
		const current = ticket;
		const submitted = phrase;
		problem = '';
		// The candidate was read earlier. Its message may since have left the
		// page, been rebuilt, or stopped being a saved source.
		if (!sourceHoldsPhrase(candidate.message, submitted)) {
			problem =
				'That text is no longer in a saved message. Select it again from the conversation.';
			return;
		}
		pending = true;
		const { data: outcome, error } = await entries.add(submitted);
		pending = false;
		// A newer candidate owns the popover now. The entry list still says what
		// happened to this one when it is selected again.
		if (current !== ticket) return;
		if (error !== null) {
			problem = 'This phrase was not saved. Nothing was added to your words.';
			return;
		}
		if (outcome === 'added') added = submitted;
		else already = submitted;
	}

	// The conversation moved on: an answer stopped or arrived. A candidate from
	// before does not come back, and neither does the selection it was read from.
	$effect(() => {
		void resetKey;
		untrack(() => {
			if (!open) return;
			if (!typed) document.getSelection()?.removeAllRanges();
			close();
			candidate = undefined;
		});
	});

	$effect(() => {
		if (!root) return;
		const element = root;
		let settle: ReturnType<typeof setTimeout> | undefined;
		let released: ReturnType<typeof setTimeout> | undefined;

		const engaged = () =>
			(content !== null && content.contains(document.activeElement)) ||
			performance.now() - touchedAt < 1000;

		function inspect(via: Via) {
			const selection = document.getSelection();
			if (!selection) return;
			// A selection inside the popover, such as text in its field, is not a phrase.
			if (content && selection.anchorNode && content.contains(selection.anchorNode))
				return;
			const captured = capturePhrase(selection);
			if (captured && element.contains(captured.message)) {
				const { range, message, messageId } = captured;
				show(
					{
						via,
						messageId,
						message,
						// The message itself, should the selected text leave the page.
						anchor: {
							getBoundingClientRect: () =>
								(range.startContainer.isConnected && !range.collapsed
									? range
									: message
								).getBoundingClientRect(),
						},
					},
					captured.text,
				);
				return;
			}
			// Nothing saveable is selected now. A typed phrase does not depend on
			// the selection, and pressing something in the popover may clear it.
			if (open && !typed && !(selection.isCollapsed && engaged())) close();
		}

		// Touch handles change a selection without any pointer event reaching
		// the page, so the selection itself is watched, and read once it rests.
		function onSelectionChange() {
			clearTimeout(settle);
			settle = setTimeout(() => inspect('selection'), 250);
		}
		// Read after the release has been applied: a click inside a selection
		// collapses it only once the button is up.
		function onPointerUp(event: PointerEvent) {
			if (
				event.target instanceof Element &&
				event.target.closest('[data-save-phrase]')
			)
				return;
			clearTimeout(released);
			released = setTimeout(() => inspect('selection'), 0);
		}
		// Letting go of Shift ends a keyboard selection; the popover then takes
		// focus, so its button is reachable without a pointer. Key events go to
		// the focused element, which is rarely inside the messages, so this
		// listens on the document.
		function onKeyUp(event: KeyboardEvent) {
			if (event.key !== 'Shift') return;
			const target = event.target;
			if (target instanceof HTMLElement) {
				if (target.isContentEditable || target.matches('input, textarea, select'))
					return;
				if (content?.contains(target)) return;
			}
			clearTimeout(settle);
			inspect('keyboard');
		}
		function onClick(event: MouseEvent) {
			const button =
				event.target instanceof Element
					? event.target.closest<HTMLElement>('[data-save-phrase]')
					: null;
			if (!button || !element.contains(button)) return;
			const messageId = button.dataset.savePhrase;
			const message = [
				...element.querySelectorAll<HTMLElement>('[data-phrase-source]'),
			].find((node) => node.dataset.phraseSource === messageId);
			if (!messageId || !message) return;
			clearTimeout(settle);
			clearTimeout(released);
			show({ via: 'button', messageId, message, anchor: button, opener: button }, '');
		}

		document.addEventListener('selectionchange', onSelectionChange);
		document.addEventListener('keyup', onKeyUp);
		element.addEventListener('pointerup', onPointerUp);
		element.addEventListener('click', onClick);
		return () => {
			clearTimeout(settle);
			clearTimeout(released);
			document.removeEventListener('selectionchange', onSelectionChange);
			document.removeEventListener('keyup', onKeyUp);
			element.removeEventListener('pointerup', onPointerUp);
			element.removeEventListener('click', onClick);
			close();
			candidate = undefined;
		};
	});
</script>

<Popover.Root
	bind:open
	onOpenChange={(next) => {
		if (!next) ticket++;
	}}
>
	<Popover.Content
		bind:ref={content}
		customAnchor={candidate?.anchor}
		side="bottom"
		collisionPadding={12}
		trapFocus={candidate?.via !== 'selection'}
		class="max-w-[calc(100vw-1.5rem)] gap-3"
		aria-label="Save a phrase"
		onpointerdown={() => (touchedAt = performance.now())}
		onmousedown={(event) => {
			// Pressing a button here must not clear the selection in the message.
			if (!typed) event.preventDefault();
		}}
		onOpenAutoFocus={(event) => {
			event.preventDefault();
			if (candidate?.via !== 'selection') focusInside();
		}}
		onCloseAutoFocus={(event) => {
			event.preventDefault();
			// Back to the button that opened it, unless focus has gone elsewhere.
			const opener = candidate?.opener;
			const active = document.activeElement;
			if (
				opener?.isConnected &&
				(!active || active === document.body || content?.contains(active))
			)
				opener.focus();
		}}
	>
		{#if typed}
			<div class="flex flex-col gap-1.5">
				<Label for="capture-phrase">Phrase from this message</Label>
				<Input
					id="capture-phrase"
					autocomplete="off"
					oncompositionstart={() => (composing = true)}
					oncompositionend={() => (composing = false)}
					bind:value={text}
					aria-describedby="capture-phrase-help"
					aria-invalid={phrase !== '' && !valid}
					onkeydown={(event) => {
						// Enter that confirms an input method's candidate is not a save.
						if (
							event.key !== 'Enter' ||
							event.isComposing ||
							composing ||
							event.keyCode === 229
						)
							return;
						event.preventDefault();
						void add();
					}}
				/>
				<p
					id="capture-phrase-help"
					class="text-xs {phrase !== '' && !valid
						? 'text-destructive'
						: 'text-muted-foreground'}"
				>
					{phrase !== '' && !valid
						? 'That is not in this message. Type it exactly as the message has it, within one line.'
						: 'Type or paste a phrase exactly as it appears in the message.'}
				</p>
			</div>
		{/if}
		{#if valid}
			<p class="text-lg font-medium break-words">{phrase}</p>
		{/if}
		{#if problem}
			<p role="alert" class="text-sm text-destructive">{problem}</p>
		{/if}
		<p role="status" class="text-sm text-muted-foreground empty:hidden">
			{#if added !== '' && added === phrase}Saved to your words.{:else if already !== '' && already === phrase}Already in your words. Its note and stage are unchanged.{/if}
		</p>
		<div class="flex flex-wrap items-center gap-2">
			<!-- Kept focusable while it cannot be pressed: a disabled button would
			     drop the keyboard's focus out of the popover. -->
			<Button
				size="sm"
				aria-disabled={blocked}
				class="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
				onclick={add}
			>
				{pending ? 'Saving...' : problem ? 'Save again' : 'Save to words'}
			</Button>
			<Button size="sm" variant="ghost" onclick={close}>Close</Button>
		</div>
	</Popover.Content>
</Popover.Root>
