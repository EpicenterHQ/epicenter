<script lang="ts">
	import { AccountPopover } from '@epicenter/app-shell/account-popover';
	import { Input } from '@epicenter/ui/input';
	import SearchIcon from '@lucide/svelte/icons/search';
	import XIcon from '@lucide/svelte/icons/x';
	import UnifiedTabList from '$lib/components/tabs/UnifiedTabList.svelte';
	import { tabManagerBoot } from '$lib/session.svelte';

	const tabManager = tabManagerBoot.tabManager;
</script>

<main class="flex h-full w-full flex-col overflow-hidden bg-background text-foreground">
	<header class="border-b bg-background px-3 py-2">
		<div class="flex items-center gap-2">
			<div class="relative flex-1">
				<SearchIcon class="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
				<Input
					type="search"
					placeholder="Search tabs and captures..."
					bind:value={tabManager.state.view.searchQuery}
					class="h-8 px-8 text-sm [&::-webkit-search-cancel-button]:hidden"
				/>
				{#if tabManager.state.view.searchQuery}
					<button
						type="button"
						aria-label="Clear search"
						class="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
						onclick={() => { tabManager.state.view.searchQuery = ''; }}
					>
						<XIcon class="size-3.5" />
					</button>
				{/if}
			</div>
			<AccountPopover
				auth={tabManagerBoot.auth}
				syncNoun="captures"
				instanceConnect={{ appName: 'Tab Manager', setting: tabManagerBoot.instanceSetting }}
			/>
		</div>
	</header>
	<div class="min-h-0 flex-1"><UnifiedTabList /></div>
</main>
