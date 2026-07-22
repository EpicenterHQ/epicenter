<script lang="ts">
	import type { FirstAttachmentChoice } from '@epicenter/data/record';
	import { Button } from '@epicenter/ui/button';
	import type { Snippet } from 'svelte';
	import { auth } from '#platform/auth';
	import { getWhisperingApp } from './context';

	const app = getWhisperingApp();
	let { children }: { children: Snippet } = $props();
	let attachment = $state(app.attachment);
	let authState = $state(auth.state);
	let choosing = $state<FirstAttachmentChoice>();
	let error = $state<string>();

	$effect(() => {
		attachment = app.attachment;
		return app.subscribeAttachment((next) => (attachment = next));
	});

	$effect(() => {
		authState = auth.state;
		return auth.onStateChange((next) => (authState = next));
	});

	async function choose(choice: FirstAttachmentChoice): Promise<void> {
		choosing = choice;
		error = undefined;
		try {
			await app.chooseFirstAttachment(choice);
		} catch (cause) {
			error =
				cause instanceof Error
					? cause.message
					: 'Could not attach local Epicenter data';
		} finally {
			choosing = undefined;
		}
	}
</script>

{#if attachment.kind === 'unattached' && attachment.requiresChoice && authState.status === 'signed-in'}
	<div
		class="flex h-dvh items-center justify-center bg-background p-6"
	>
		<div class="w-full max-w-lg space-y-4 rounded-lg border p-6 shadow-sm">
			<h1 class="text-lg font-semibold">Choose what to do with local Epicenter data</h1>
			<p class="text-sm text-muted-foreground">
				Bring keeps records saved by Home, Whispering, and installed apps, then
				adds them to your account. Discard permanently removes all local
				Epicenter records before syncing.
			</p>
			<div class="flex flex-wrap gap-2">
				<Button disabled={choosing !== undefined} onclick={() => choose('bring')}>
					{choosing === 'bring' ? 'Bringing…' : 'Bring local data'}
				</Button>
				<Button
					variant="destructive"
					disabled={choosing !== undefined}
					onclick={() => choose('discard')}
				>
					{choosing === 'discard' ? 'Discarding…' : 'Discard all local data'}
				</Button>
			</div>
			{#if error}
				<p class="text-sm text-destructive" aria-live="polite">{error}</p>
			{/if}
		</div>
	</div>
{:else}
	{@render children()}
{/if}
