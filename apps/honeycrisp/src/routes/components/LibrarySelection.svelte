<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import type { Library } from '$lib/application.js';

	let { library, canOpenShared, select }: {
		library: Library;
		canOpenShared: boolean;
		select: (library: Library) => Promise<void>;
	} = $props();
	let pending = $state(false);
	let error = $state('');
	async function choose(next: Library) {
		pending = true;
		try {
			await select(next);
		} catch {
			error = 'Could not switch libraries. Keep this window open.';
			pending = false;
		}
	}
</script>

<nav aria-label="Library" class="flex flex-wrap gap-1">
	{#each ['local', 'personal', 'shared'] as const as choice}
		<Button
			size="sm"
			variant={library === choice ? 'secondary' : 'ghost'}
			aria-pressed={library === choice}
			disabled={pending || (choice === 'shared' && !canOpenShared && library !== 'shared')}
			title={choice === 'shared' && !canOpenShared ? 'Connect to your own server to use Shared' : undefined}
			onclick={() => { void choose(choice); }}
		>
			{{ local: 'Local', personal: 'Personal', shared: 'Shared' }[choice]}
		</Button>
	{/each}
</nav>
{#if error}<p role="alert" class="text-sm text-destructive">{error}</p>{/if}
