<script lang="ts">
	import { getVocabSurface } from "$lib/surface";
	import { Button } from '@epicenter/ui/button';
	import { toast } from '@epicenter/ui/sonner';
	import { Spinner } from '@epicenter/ui/spinner';
	import CircleStopIcon from '@lucide/svelte/icons/circle-stop';
	import MicIcon from '@lucide/svelte/icons/mic';
	import { extractErrorMessage } from 'wellcrafted/error';

	let {
		onTranscript,
		disabled = false,
	}: {
		/** Called with the recognized text once a spoken phrase transcribes. */
		onTranscript: (text: string) => void;
		/**
		 * Lock opening the mic, e.g. while a turn is generating. An open session
		 * can always be stopped: never trap a live mic behind a disabled button.
		 */
		disabled?: boolean;
	} = $props();

	// Thin state-machine router: the listen/transcribe work lives in the
	// dictation state; here we only toggle the session and route each phrase's
	// Result to the transcript callback or a toast. A failed phrase toasts and
	// the session keeps listening.
	async function toggle() {
		if (dictation.status !== 'idle') {
			const { error: stopError } = await dictation.stop();
			if (stopError) {
				toast.error('Could not stop dictation', {
					description: extractErrorMessage(stopError),
				});
			}
			return;
		}

		const { error: startError } = await dictation.start({
			onTranscript: ({ data: text, error: transcribeError }) => {
				if (transcribeError) {
					toast.error('Could not transcribe that', {
						description: extractErrorMessage(transcribeError),
					});
					return;
				}
				if (text) onTranscript(text);
			},
		});
		if (startError) {
			toast.error('Could not start dictation', {
				description: extractErrorMessage(startError),
			});
		}
	}
	const { dictation } = getVocabSurface();
</script>

<Button
	variant={dictation.status === 'idle' ? 'outline' : 'destructive'}
	size="icon-lg"
	type="button"
	onclick={toggle}
	disabled={dictation.status === 'idle' && (disabled || dictation.isTranscribing)}
	aria-label={dictation.status === 'idle'
		? 'Dictate a message'
		: 'Stop dictating'}
>
	{#if dictation.status === 'speaking'}
		<CircleStopIcon class="animate-pulse" />
	{:else if dictation.status === 'listening'}
		<CircleStopIcon />
	{:else if dictation.isTranscribing}
		<Spinner />
	{:else}
		<MicIcon />
	{/if}
</Button>
