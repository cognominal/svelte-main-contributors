- `src/routes/+layout.svelte`
  Global layout with tab navigation between explore and manage views.
- `src/routes/manage/+page.svelte`
  Placeholder page reserved for upcoming repository management tools.
- `src/routes/api/local-repos/+server.ts`
  Returns the cached owner to repository map from local clones.
- `src/routes/api/storage/+server.ts`
  Reports filesystem usage for the shared git cache directory.
- `src/routes/api/contribs/+server.ts`
  Streams contributor summaries and git progress events over NDJSON.
- `src/routes/+page.ts`
  Loads the owner map to prime autocomplete suggestions on the client.
- `src/routes/+page.svelte`
  Main explore interface handling search, streaming, charts, and state.
- `src/lib/components/ContributionChart.svelte`
  Renders contributor time series using d3 scales and SVG paths.
- `src/lib/components/contribution-progress.ts`
  Helper utilities for tracking and rendering streamed progress entries.
- `src/lib/components/autocomplete/AutocompleteInput.svelte`
  Styled autocomplete input with dropdown interactions and keyboard flow.
- `src/lib/components/autocomplete/index.ts`
  Barrel file re-exporting the autocomplete input component.
- `src/lib/components/ui/progress-panel.svelte`
  Card-based panel that lists live progress messages for fetch operations.
- `src/lib/components/ui/card/card-footer.svelte`
  Wrapper for card footer content within shadcn card primitives.
- `src/lib/components/ui/card/card-content.svelte`
  Wrapper for main card body content within shadcn card primitives.
- `src/lib/components/ui/card/index.ts`
  Barrel file re-exporting shadcn-styled card subcomponents.
- `src/lib/components/ui/card/card.svelte`
  Base card container applying shared border, radius, and shadow styles.
- `src/lib/components/ui/card/card-description.svelte`
  Description slot wrapper with subdued typography inside cards.
- `src/lib/components/ui/card/card-header.svelte`
  Header slot wrapper that spaces card titles and meta text.
- `src/lib/components/ui/card/card-title.svelte`
  Heading styled wrapper for card title content.
- `src/lib/components/ui/tabs/tabs-trigger.svelte`
  Trigger button styling for bits-ui powered shadcn tabs.
- `src/lib/components/ui/tabs/index.ts`
  Barrel file re-exporting the custom tab primitives.
- `src/lib/components/ui/tabs/tabs-content.svelte`
  Wrapper providing layout for the active tab panel.
- `src/lib/components/ui/tabs/tabs.svelte`
  Root tabs component configuring bits-ui tab behavior.
- `src/lib/components/ui/tabs/tabs-list.svelte`
  Container that arranges tab trigger buttons in a row.
- `src/lib/types.ts`
  Shared TypeScript models for contributor summaries and metadata.
- `src/lib/server/ownerMap.ts`
  Builds and caches the owner to repo index from ~/git clones.
- `src/lib/server/cache.ts`
  Persistent JSON cache with pruning for GitHub profile lookups.
- `src/lib/server/svgChart.ts`
  Generates SVG charts for contributor activity suitable for export.
- `src/lib/server/gitStats.ts`
  Collects git logs, aggregates commits, and resolves contributor profiles.
- `src/lib/utils.ts`
  Utility helpers including Tailwind class merger utilities.
- `src/lib/autocomplete/completion.svelte.ts`
  Autocomplete controller managing async suggestions and validation.
- `src/lib/autocomplete.ts`
  Fetch helper that wraps GitHub autocomplete HTTP calls.
- `src/lib/thumbnails.ts`
  Captures rendered SVG charts into PNG data URLs for previews.
- `src/cli.ts`
  CLI entry that emits SVG charts from the contribution summary pipeline.
- `src/app.d.ts`
  Ambient SvelteKit module declarations placeholder.
- `tailwind.config.ts`
  Tailwind theme and animation configuration for the app.
- `vite.config.ts`
  Vite configuration enabling SvelteKit and inlining bits-ui.
