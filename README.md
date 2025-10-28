# Contribs

Contribs is a Bun-powered SvelteKit project for exploring repository contributors. It ships with a web UI for browsing contribution charts and a CLI that renders the top contributors per interval as an SVG.

## Prerequisites
- [Bun](https://bun.sh/) ≥ 1.0

## Install
```bash
bun install
```

## Web App
- `bun run dev` &mdash; start the Vite dev server
- `bun run build` &mdash; produce a production build
- `bun run preview` &mdash; preview the production build locally

Giving a correct repo owner and typing enter will clone or update, and display the SVGs for the 5 most starred 
repositories for that owner.
Given a owner, selecting a repo and  typing enter displays the SVG for that sole repo.
You can scroll horizontally between them.
Hovering over a user name will highlight the curve for him.


## CLI
Generate a contribution chart for a GitHub repository:
```bash
bun run contribs <owner>/<repo> <contributors-per-interval>
```

The CLI syncs the repository, aggregates commits, and saves an SVG named like `owner--repo--top-5.svg` in the current directory. Use a positive integer for the contributor limit; the interval (month or year) is inferred automatically.

## Checks
- `bun run check` &mdash; run SvelteKit's type and accessibility checks

## UI Components
- Tailwind CSS v4 is configured in `tailwind.config.ts` and `postcss.config.cjs`. Global tokens live in `src/app.postcss`.
- Use `npx shadcn-svelte@latest add <component>` to pull new primitives into `$lib/components/ui`; the CLI reads defaults from `components.json`.
- Reuse the `cn` helper in `src/lib/utils.ts` when composing utility classes, and keep shared helpers under `$lib/utils`.
- Import `../app.postcss` inside any new layout roots so Tailwind layers stay active.

## Environment
- Set `VITE_GITHUB_TOKEN` (optional) to raise API rate limits for owner/repository auto-complete and top-starred batch syncing.
- UI code uses modern Svelte event attributes (`onclick`, `onmouseenter`, ...). Avoid the deprecated `on:` syntax when adding handlers.

## Docker

Build a production image:

```bash
docker build -t contribs .
```

Run it (the preview server listens on port 4173):

```bash
docker run --rm -p 4173:4173 contribs
```
