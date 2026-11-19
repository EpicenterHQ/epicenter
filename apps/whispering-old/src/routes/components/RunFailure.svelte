<script lang="ts">
	import { Button } from '@epicenter/ui/button';

	/**
	 * Why a transcription started here failed. Nothing is kept for it: Try
	 * again sends the same request again, and Dismiss forgets it.
	 */
	let {
		message,
		onRetry,
		onDismiss,
	}: { message: string; onRetry: () => void; onDismiss: () => void } = $props();
</script>

<div class="flex flex-col gap-1.5 text-sm" data-testid="run-failure">
	<p class="text-destructive" role="alert" data-testid="run-error">{message}</p>
	<div class="flex items-center gap-1">
		<Button size="xs" onclick={onRetry} data-testid="run-again">Try again</Button>
		<Button size="xs" variant="ghost" onclick={onDismiss} data-testid="dismiss-run">Dismiss</Button>
	</div>
</div>
