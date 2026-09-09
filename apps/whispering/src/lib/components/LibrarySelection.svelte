<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Err, tryAsync } from 'wellcrafted/result';
	import { extractErrorMessage } from 'wellcrafted/error';
	import type { Library } from '../bootstrap.js';

	let { library, canOpenShared, select }: {
		library: Library;
		canOpenShared: boolean;
		select: (library: Library) => Promise<void>;
	} = $props();
	let pending = $state(false);
	let error = $state('');
	async function choose(next: Library) {
		pending = true;
		error = '';
		const result = await tryAsync({
			try: () => select(next),
			catch: (cause) => Err(extractErrorMessage(cause)),
		});
		if (result.error) error = result.error;
		pending = false;
	}
</script>

<nav aria-label="Library" class="flex flex-wrap gap-1 border-b bg-background px-4 py-2">
	{#each ['local', 'personal', 'shared'] as const as choice}
		<Button
			size="sm"
			variant={library === choice ? 'secondary' : 'ghost'}
			aria-pressed={library === choice}
			disabled={pending || (choice === 'shared' && !canOpenShared && library !== 'shared')}
			title={choice === 'shared' && !canOpenShared ? 'Connect to your own server to use Shared' : undefined}
			onclick={() => choose(choice)}
		>
			{{ local: 'Local', personal: 'Personal', shared: 'Shared' }[choice]}
		</Button>
	{/each}
</nav>
{#if error}<p role="alert" class="px-4 text-sm text-destructive">{error}</p>{/if}
