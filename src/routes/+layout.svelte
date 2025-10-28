<script lang="ts">
	import '../app.postcss';
	import { page } from '$app/stores';
	import { Tabs as TabsRoot, TabsList, TabsTrigger } from '$lib/components/ui/tabs';

	const { children } = $props();

	const tabs = [
		{ label: 'Manage', value: 'manage', href: '/manage' },
		{ label: 'Explore', value: 'explore', href: '/' }
	] as const;

	const normalize = (value: string) => {
		const trimmed = value.replace(/\/+$/, '');
		return trimmed.length > 0 ? trimmed : '/';
	};

	const inferTab = (pathname: string) => {
		const normalizedPath = normalize(pathname);
		if (normalizedPath === '/' || normalizedPath.startsWith('/explore')) {
			return 'explore';
		}
		return 'manage';
	};
</script>

<div class="min-h-screen bg-background text-foreground">
	<nav class="border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
		<div class="mx-auto flex h-16 max-w-6xl items-end px-4 sm:px-6">
			<TabsRoot value={inferTab($page.url.pathname)} class="w-full">
				<TabsList class="inline-flex h-10 items-center gap-1 rounded-lg bg-muted/60 p-1">
					{#each tabs as tab}
						<TabsTrigger
							value={tab.value}
							class="data-[state=active]:text-primary data-[state=active]:bg-background data-[state=active]:shadow-sm inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
						>
							<a
								href={tab.href}
								data-sveltekit-prefetch
								class="inline-flex w-full justify-center"
								aria-current={inferTab($page.url.pathname) === tab.value ? 'page' : undefined}
							>
								{tab.label}
							</a>
						</TabsTrigger>
					{/each}
				</TabsList>
			</TabsRoot>
		</div>
	</nav>
	<main class="px-4 pb-8 pt-6 sm:px-6">
		{@render children?.()}
	</main>
</div>
