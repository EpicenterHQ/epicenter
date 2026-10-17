<!--
	A failed save's toast once copying its text did not work: what failed,
	and the text itself in a read-only box, selected when focused, so the
	person can still copy it by hand. Pressing in the box does not start the
	toast's swipe, so a drag selects text.
-->
<script lang="ts">
	let { message, text }: { message: string; text: string } = $props();
</script>

<p>{message}</p>
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
