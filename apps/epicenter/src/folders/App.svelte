<script lang="ts">
	/**
	 * The Folders window, waiting for the folder model's page: it will list
	 * every folder in the Epicenter folder and keep each in sync by composing
	 * `@epicenter/folder/platform` here (ADR-0816, ADR-0817, ADR-0819), and it
	 * no longer runs the `epicenter` command, which no app calls. Until then it
	 * says what to run instead.
	 */
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import { commands } from '../ui/bindings.gen';

	const steps = [
		['epicenter status', 'your folders, their state, and the shares waiting for you'],
		['epicenter sync --all', 'sync every folder that changed'],
		['epicenter share <folder> <email>', 'share a folder with someone'],
		['epicenter accept', 'accept a folder shared with you'],
	] as const;
</script>

<main class="mx-auto flex max-w-xl flex-col gap-6 p-8">
	<header class="flex items-center justify-between gap-4">
		<h1 class="text-xl font-semibold tracking-tight">Folders</h1>
		<Button variant="outline" onclick={() => commands.openHome()}>Settings</Button>
	</header>
	<Alert.Root>
		<Alert.Title>Folders are not shown here yet</Alert.Title>
		<Alert.Description>
			Epicenter is moving to folders you can share with people directly. Until this
			window shows them, use the epicenter command in a terminal.
		</Alert.Description>
	</Alert.Root>
	<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
		{#each steps as [command, what] (command)}
			<dt><code class="font-mono">{command}</code></dt>
			<dd class="text-muted-foreground">{what}</dd>
		{/each}
	</dl>
</main>
