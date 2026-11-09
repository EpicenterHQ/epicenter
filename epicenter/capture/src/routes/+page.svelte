<script lang="ts">
	import { connect } from '@epicenter/app/client';
	import { Button } from '@epicenter/ui/button';

	const capture = connect('capture');
	let rows = $state<Record<string, unknown>[]>([]);
	let problem = $state<string>();

	async function load() {
		try {
			rows = await capture.call('captures list');
			problem = undefined;
		} catch (error) {
			problem = String(error);
		}
	}
	load();
</script>

<main class="mx-auto max-w-xl p-4">
	<h1 class="text-xl font-semibold">Capture</h1>
	{#if problem}<p class="text-destructive">{problem}</p>{/if}
	<p>{rows.length} captures</p>
	<Button onclick={load}>Reload</Button>
</main>
