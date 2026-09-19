<script lang="ts">
	import { getConnectionScreen } from '@epicenter/app-shell/boot-screens';
	import { auth } from '#platform/auth';
	import { Button } from '@epicenter/ui/button';
	import * as DropdownMenu from '@epicenter/ui/dropdown-menu';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import LibraryIcon from '@lucide/svelte/icons/library';
	import { Err, tryAsync } from 'wellcrafted/result';
	import { extractErrorMessage } from 'wellcrafted/error';
	type Library = 'local' | 'personal';

	let { library, select }: {
		library: Library;
		select: (library: Library) => Promise<void>;
	} = $props();
	const openConnection = getConnectionScreen();
	const labels = { local: 'On this device', personal: 'Personal library' };
	let pending = $state(false);
	let error = $state('');
	async function choose(next: Library) {
		if (pending || next === library) return;
		if (next === 'personal' && !auth.getState().account && openConnection) {
			localStorage.setItem('whispering.library', next);
			openConnection();
			return;
		}
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

<DropdownMenu.Root>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			<Button {...props} variant="ghost" size="sm" disabled={pending}
				class="w-full justify-start group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:p-0"
				aria-label="Recording library: {labels[library]}" tooltip={labels[library]}>
				<LibraryIcon class="size-4" />
				<span class="truncate group-data-[collapsible=icon]:hidden">{pending ? 'Switching library…' : labels[library]}</span>
				<ChevronDownIcon class="ml-auto size-4 group-data-[collapsible=icon]:hidden" />
			</Button>
		{/snippet}
	</DropdownMenu.Trigger>
	<DropdownMenu.Content align="start">
		<DropdownMenu.Label>Recording library</DropdownMenu.Label>
		<DropdownMenu.RadioGroup value={library}>
			{#each ['local', 'personal'] as const as choice}
				<DropdownMenu.RadioItem value={choice} disabled={pending} onSelect={() => choose(choice)}>
					{labels[choice]}
				</DropdownMenu.RadioItem>
			{/each}
		</DropdownMenu.RadioGroup>
		<DropdownMenu.Separator />
		<p class="max-w-56 px-2 py-1 text-xs text-muted-foreground">Each library has its own recordings. Switching does not move them.</p>
	</DropdownMenu.Content>
</DropdownMenu.Root>
{#if error}<p role="alert" class="px-2 text-sm text-destructive">{error}</p>{/if}
