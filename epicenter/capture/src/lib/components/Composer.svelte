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
	import ArrowUpIcon from '@lucide/svelte/icons/arrow-up';
	import { captures } from '$lib/captures.svelte.js';
	import { hasKeyboard } from '$lib/keys.js';

	let text = $state('');
	// SvelteKit focuses an `autofocus` element after each navigation; a phone would open its keyboard.
	const autofocus = hasKeyboard();

	async function add() {
		const submitted = text;
		if (submitted.trim() === '') return;
		text = '';
		if (!(await captures.add(submitted)) && text === '') text = submitted;
	}
</script>

<form
	onsubmit={(event) => {
		event.preventDefault();
		void add();
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
				void add();
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
