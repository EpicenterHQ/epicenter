<!--
	The box a capture is typed into, first on the page. Add clears it at once
	and lists the capture while it is written; if the write fails, the text
	comes back here unless something new was typed.

	With a keyboard and pointer (a computer), Enter adds and Shift+Enter
	starts a new line. On a touch screen, Return starts a new line and the
	button adds, since a phone keyboard has no Shift+Enter.
-->
<script lang="ts">
	import * as InputGroup from '@epicenter/ui/input-group';
	import { toast } from '@epicenter/ui/sonner';
	import ArrowUpIcon from '@lucide/svelte/icons/arrow-up';
	import { createMutation } from '@tanstack/svelte-query';
	import { writes } from '$lib/app.js';
	import { hasKeyboard } from '$lib/keys.js';

	const addCapture = createMutation(() => writes.add);

	let text = $state('');
	// SvelteKit focuses an `autofocus` element after each navigation; a phone would open its keyboard.
	const autofocus = hasKeyboard();

	function add() {
		const submitted = text;
		if (submitted.trim() === '') return;
		text = '';
		addCapture.mutate(
			{ text: submitted },
			{
				onError: (error) => {
					toast.error('Not captured', { description: error.message });
					if (text === '') text = submitted;
				},
			},
		);
	}
</script>

<form
	onsubmit={(event) => {
		event.preventDefault();
		add();
	}}
>
	<InputGroup.Root class="bg-background">
		<InputGroup.Textarea
			{autofocus}
			bind:value={text}
			aria-label="New capture"
			placeholder="What's on your mind?"
			rows={2}
			class="max-h-[40vh] min-h-14 leading-relaxed"
			onkeydown={(event) => {
				if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
				if (!(event.metaKey || event.ctrlKey || hasKeyboard())) return;
				event.preventDefault();
				add();
			}}
		/>
		<InputGroup.Addon align="block-end" class="justify-between">
			<span class="text-xs text-muted-foreground pointer-coarse:invisible">
				Enter to add, Shift+Enter for a new line
			</span>
			<InputGroup.Button
				type="submit"
				variant="default"
				size="icon-sm"
				class="rounded-full"
				disabled={text.trim() === ''}
				aria-label="Add capture"
			>
				<ArrowUpIcon />
			</InputGroup.Button>
		</InputGroup.Addon>
	</InputGroup.Root>
</form>
