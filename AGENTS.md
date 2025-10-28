# Agents and Workflow

This repository was modified with the support of an automated assistant operating within a Bun + SvelteKit project.

## Active directives

- All git repositories are cloned into `~/git` on demand; the directory is created if missing.
- Every git command (`clone`, `fetch`, `pull`, `unshallow`) is executed with `--progress` to surface progress even without a TTY.
- Long-running git operations must respect an `AbortSignal`. Cancelling a request terminates outstanding clones and fetches.
- Progress updates are streamed via NDJSON from the server to the web client, including status messages and raw git output.
- The web client maintains a rolling window of timestamped progress entries and collapses repeated git output per command.
- The CLI mirrors progress reporting by plumbing the same callbacks to stdout and stderr.
- Contribution charts accept a `highlighted` contributor, dimming other series; legend and summary rows emit highlight events on hover/focus.
- Contribution charts now render in a horizontal scroll strip when multiple summaries are present; the active pane drives the summary table and detail panels.
- Web requests include an `excludeBots` flag; the web UI requests full data (`false`) and applies a case-insensitive "bot" filter client-side so the toggle can show/hide bots instantly.
- The UI can request and render up to five of the currently selected owner's most-starred repositories; the API validates the owner, fetches their repositories via GitHub's REST search, and clones each sequentially while streaming per-repo progress.
- Horizontal chart scrolling captures wheel and touch gestures to prevent MacOS swipe navigation while panning between SVG panes.
- Event handling uses the modern attribute syntax (`onclick`, `onmouseenter`, etc.) for compatibility with Svelte 5 semantics.
- New UI work must use shadcn-svelte components (via `npx shadcn-svelte@latest add <component>`) and live under `$lib/components/ui`.
- Type safety is enforced via `bun --bunx svelte-check --tsconfig ./tsconfig.json`; changes must pass before landing.
