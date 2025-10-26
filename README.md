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

## CLI
Generate a contribution chart for a GitHub repository:
```bash
bun run contribs <owner>/<repo> <contributors-per-interval>
```

The CLI syncs the repository, aggregates commits, and saves an SVG named like `owner--repo--top-5.svg` in the current directory. Use a positive integer for the contributor limit; the interval (month or year) is inferred automatically.

## Checks
- `bun run check` &mdash; run SvelteKit's type and accessibility checks

