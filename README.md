# Contribs

github-manage is  a Bun-powered [shadcn](https://www.shadcn-svelte.com/)
[SvelteKit](https://svelte.dev/) project to explore github repos

It allows to focus on the most starred projects and more prolific
contributors and clone some chosen repos (with the chosen depth to
avoid using too much disk space. TBD).

It has two tabs. Currently only the `explore` page exist. The manage page
will allow to manage cloned repo.

Currently it is very aggressive in cloning.

The cloned repos are under `~/git/userName---repoName`. If repo have
`---` in their name, you may be out of luck (untested)

It ships with a web UI for browsing contribution to chart the top
contributors per interval as an SVG.

## Documentation

- [CACHING.md](CACHING.md) &mdash; caching mechanism and performance
- [GITHUB.md](GITHUB.md) &mdash; GitHub API usage and endpoints
- [THUMBNAILS.md](THUMBNAILS.md) &mdash; thumbnail generation process

## Prerequisites

## Install

```bash
bun install
```

## Web App

- `bun run dev` &mdash; start the Vite dev server
- `bun run build` &mdash; produce a production build
- `bun run preview` &mdash; preview the production build locally

Giving a correct repo owner and typing enter will clone or update, and
display the SVGs for the 5 most starred repositories for that owner.
Given a owner, selecting a repo and typing enter displays the SVG for
that sole repo. You can scroll horizontally between them. Hovering over
a user name will highlight the curve for him.

### Session Persistence

The web app automatically saves your last query in a cookie (expires
after 30 days). When you reload the page:

- Form fields (owner, repo, limit, exclude bots) are restored
- The query is automatically re-submitted after 100ms
- Works for both specific repo queries and top-starred searches
- Contribution data remains cached, so subsequent loads are faster

This allows you to close and reopen the browser tab without losing your
place. The session cookie stores:

- Repository owner and name (if specific repo query)
- Number of contributors to display
- Bot filtering preference
- Top-starred search flag

To start fresh, simply submit a new query or clear your browser
cookies.

## CLI

Generate a contribution chart for a GitHub repository:

```bash
bun run contribs <owner>/<repo> <contributors-per-interval>
```

The CLI syncs the repository, aggregates commits, and saves an SVG
named like `owner--repo--top-5.svg` in the current directory. Use a
positive integer for the contributor limit; the interval (month or
year) is inferred automatically.

## Checks

- `bun run check` &mdash; run SvelteKit's type and accessibility checks

## UI Components

- Tailwind CSS v4 is configured in `tailwind.config.ts` and
  `postcss.config.cjs`. Global tokens live in `src/app.postcss`.
- Use `npx shadcn-svelte@latest add <component>` to pull new primitives
  into `$lib/components/ui`; the CLI reads defaults from
  `components.json`.
- Reuse the `cn` helper in `src/lib/utils.ts` when composing utility
  classes, and keep shared helpers under `$lib/utils`.
- Import `../app.postcss` inside any new layout roots so Tailwind
  layers stay active.

## Environment

- Set `VITE_GITHUB_TOKEN` (optional) to raise API rate limits for
  owner/repository auto-complete and top-starred batch syncing.
- UI code uses modern Svelte event attributes (`onclick`,
  `onmouseenter`, ...). Avoid the deprecated `on:` syntax when adding
  handlers.

## Docker

Build a production image:

```bash
docker build -t contribs .
```

Run it (the preview server listens on port 4173):

```bash
docker run --rm -p 4173:4173 contribs
```

## History

The project started as a vibe coded shell script
provided here [clone-gh-repo](bin/clone-gh-repo)
