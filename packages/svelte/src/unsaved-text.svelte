<!--
	A failed save's toast description: what failed; once its editor is gone or
	copying did not work, the text itself in a read-only box, selected when
	focused, so the person can still copy it by hand; while the edit is still on screen,
	a way to discard it. Pressing in the box does not start the toast's swipe,
	so a drag selects text.
-->
<script lang="ts">
	let {
		message,
		text,
		discard,
	}: {
		message: string;
		/** The text to select by hand when its editor is gone or copying failed. */
		text?: string;
		/** Let go of the edit on screen; the toast keeps the text to copy. */
		discard?: () => void;
	} = $props();
</script>

<p>{message}</p>
{#if text !== undefined}
	<textarea
		readonly
		rows="4"
		aria-label="Your text"
		data-testid="unsaved-text"
		class="mt-2 w-full resize-y rounded-sm border bg-background p-1 font-mono text-xs text-foreground select-text"
		value={text}
		onfocus={(event) => event.currentTarget.select()}
		onpointerdown={(event) => event.stopPropagation()}
	></textarea>
{/if}
{#if discard}
	<button
		type="button"
		class="mt-1 text-xs underline underline-offset-2"
		onclick={discard}
	>
		Discard your edit
	</button>
{/if}
