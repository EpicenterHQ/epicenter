<!--
	Development only: add a recording with a made-up length and transcript
	and no audio, through the same mutation a finished take uses. It shows
	the files working without a microphone, in the desktop app or a browser.
-->
<script lang="ts">
	import { timeId } from '@epicenter/app/time';
	import { Button } from '@epicenter/ui/button';
	import { toastOnError } from '@epicenter/ui/toast-on-error';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import { runMutation } from 'wellcrafted/query';
	import { queryClient, recordingsMutations } from '#lib/queries.ts';

	const SAMPLES = [
		'Remind me to send the invoice before Friday.',
		'The meeting moved to Thursday at three.',
		'Buy oat milk, coffee filters and batteries.',
		'Draft a reply saying the build is fixed on main.',
	];

	async function add() {
		const id = timeId();
		const added = await runMutation(queryClient, recordingsMutations.add, {
			id,
			durationMs: 1000 + Math.round(Math.random() * 30_000),
			transcript: SAMPLES[Math.floor(Math.random() * SAMPLES.length)],
		});
		toastOnError(added, 'Could not add the sample');
	}
</script>

<Button variant="ghost" size="sm" onclick={add}>
	<PlusIcon />
	Add sample
</Button>
