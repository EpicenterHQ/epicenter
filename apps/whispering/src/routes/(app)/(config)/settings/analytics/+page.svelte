<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import * as Card from '@epicenter/ui/card';
	import * as SectionHeader from '@epicenter/ui/section-header';
	import { SettingSwitch } from '$lib/components/settings';
	import { logAnalyticsEvent } from '$lib/operations/analytics';
	import { getWhisperingApp } from '$lib/whispering/context';

	const app = getWhisperingApp();
</script>

<div class="space-y-8">
	<!-- Page Header -->
	<SectionHeader.Root>
		<div class="flex items-center gap-3">
			<SectionHeader.Title level={3} class="text-xl tracking-tight"
				>Analytics</SectionHeader.Title
			>
			{#if app.settings.get('analytics.enabled')}
				<Badge
					variant="outline"
					class="text-xs text-green-700 dark:text-green-400 border-green-200 dark:border-green-400/30"
				>
					Enabled
				</Badge>
			{:else}
				<Badge
					variant="outline"
					class="text-xs text-warning dark:text-warning border-warning dark:border-warning/30"
				>
					Disabled
				</Badge>
			{/if}
		</div>
		<SectionHeader.Description class="max-w-2xl">
			Help us understand which features are used most. We use anonymized event
			logging to improve Whispering.
		</SectionHeader.Description>
	</SectionHeader.Root>

	<Card.Root>
		<Card.Content class="py-2">
			<SettingSwitch
				key="analytics.enabled"
				label="Share anonymized events"
				description='We log simple events like "recording started" or "transcription completed". No personal data is attached to any of these events.'
				onCheckedChange={(checked) => {
					// Log the change (only actually sends if analytics is now enabled).
					if (checked) {
						void logAnalyticsEvent(app, {
							type: 'settings_changed',
							section: 'analytics',
						});
					}
				}}
			/>
		</Card.Content>
	</Card.Root>

	<div class="grid gap-x-8 gap-y-6 px-1 sm:grid-cols-2">
		<div class="space-y-2">
			<p
				class="text-xs font-medium uppercase tracking-wide text-green-700 dark:text-green-400"
			>
				Events we log
			</p>
			<ul class="text-sm text-muted-foreground space-y-1 leading-relaxed">
				<li>Button clicks (which features you use)</li>
				<li>Completion times (how long things take)</li>
				<li>Error messages (when something fails)</li>
			</ul>
		</div>
		<div class="space-y-2">
			<p class="text-xs font-medium uppercase tracking-wide text-muted-foreground">
				Never collected
			</p>
			<ul class="text-sm text-muted-foreground space-y-1 leading-relaxed">
				<li>Your actual transcriptions or recordings</li>
				<li>Device IDs or user identifiers</li>
				<li>API keys or any personal data</li>
			</ul>
		</div>
	</div>

	<!-- Transparency Section -->
	<Card.Root class="bg-muted/30 border-dashed">
		<Card.Header>
			<Card.Title class="text-base font-medium">Full Transparency</Card.Title>
			<Card.Description>
				All analytics code is open source and auditable. See exactly what data
				is collected and when.
			</Card.Description>
		</Card.Header>
		<Card.Content class="space-y-3">
			<div class="grid gap-2 text-sm">
				<a
					href="https://github.com/EpicenterHQ/epicenter/blob/main/apps/whispering/src/lib/services/analytics/types.ts"
					target="_blank"
					rel="noopener noreferrer"
					class="group flex items-center gap-2 text-primary hover:text-primary/80 transition-colors"
				>
					<span
						class="text-muted-foreground group-hover:text-primary/60 transition-colors"
						>→</span
					>
					<span
						class="underline underline-offset-4 decoration-transparent group-hover:decoration-current transition-colors"
						>View event definitions</span
					>
				</a>
				<a
					href="https://github.com/search?q=repo%3AEpicenterHQ%2Fepicenter+logEvent&type=code"
					target="_blank"
					rel="noopener noreferrer"
					class="group flex items-center gap-2 text-primary hover:text-primary/80 transition-colors"
				>
					<span
						class="text-muted-foreground group-hover:text-primary/60 transition-colors"
						>→</span
					>
					<span
						class="underline underline-offset-4 decoration-transparent group-hover:decoration-current transition-colors"
						>See where events are logged</span
					>
				</a>
				<a
					href="https://github.com/aptabase"
					target="_blank"
					rel="noopener noreferrer"
					class="group flex items-center gap-2 text-primary hover:text-primary/80 transition-colors"
				>
					<span
						class="text-muted-foreground group-hover:text-primary/60 transition-colors"
						>→</span
					>
					<span
						class="underline underline-offset-4 decoration-transparent group-hover:decoration-current transition-colors"
						>Learn about Aptabase</span
					>
				</a>
			</div>
		</Card.Content>
	</Card.Root>

	<!-- Status Footer -->
	<div class="flex items-center gap-2 text-xs">
		{#if app.settings.get('analytics.enabled')}
			<div class="flex items-center gap-2 text-green-700 dark:text-green-400">
				<div class="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
				<span class="font-medium">Analytics active</span>
				<span class="text-muted-foreground"
					>• Changes take effect immediately</span
				>
			</div>
		{:else}
			<div class="flex items-center gap-2 text-warning dark:text-warning">
				<div class="w-2 h-2 bg-warning rounded-full"></div>
				<span class="font-medium">Analytics disabled</span>
				<span class="text-muted-foreground">• No data is being collected</span>
			</div>
		{/if}
	</div>
</div>
