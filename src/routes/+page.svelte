<script lang="ts">
  import ContributionChart from "$lib/components/ContributionChart.svelte";
  import { fade } from "svelte/transition";
  import { tick } from "svelte";
  import type { AggregationInterval, ContributorSeries } from "$lib/types";

  interface SummaryPayload {
    slug: string;
    interval: AggregationInterval;
    startDate: string;
    endDate: string;
    series: ContributorSeries[];
    periods: Array<{
      label: string;
      start: string;
      end: string;
      contributors: Array<{
        author: string;
        commits: number;
        profileUrl?: string;
      }>;
    }>;
  }

  let owner = $state("");
  let repo = $state("");
  let limit = $state(5);
  let loading = $state(false);
  let errorMessage = $state("");
  let summaries = $state<SummaryPayload[]>([]);
  let selectedIndex = $state(0);
  interface ProgressEntry {
    id: string;
    message: string;
    timestamp: number;
    kind: "status" | "git";
    command?: string;
  }

  let progressEntries = $state<ProgressEntry[]>([]);
  let activeController: AbortController | null = null;
  const gitEntryLookup = new Map<string, string>();
  let highlightedContributor = $state<string | null>(null);
  let includeTopStarred = $state(false);
  let excludeBots = $state(true);
  let chartStrip = $state<HTMLDivElement | null>(null);
  let batchStatus = $state<{ slug: string; current: number; total: number } | null>(null);
  let descriptions = $state<Array<string | undefined>>([]);
  const topStarredLabel = $derived(
    owner.trim().length
      ? `Use ${owner.trim()}'s top starred repos`
      : "Use owner's top starred repos"
  );
  const GITHUB_BASE_URL = "https://github.com";

  const examples = [
    { owner: "torvalds", repo: "linux" },
    { owner: "microsoft", repo: "TypeScript" },
    { owner: "sveltejs", repo: "kit" },
    { owner: "deepseek-ai", repo: "DeepSeek-R1" },
  ];

  async function handleSubmit(event?: SubmitEvent) {
    event?.preventDefault();
    const trimmedOwner = owner.trim();
    const trimmedRepo = repo.trim();
    const contributorLimit = Number(limit);

    if (
      (includeTopStarred && !trimmedOwner) ||
      (!includeTopStarred && (!trimmedOwner || !trimmedRepo)) ||
      !Number.isFinite(contributorLimit) ||
      contributorLimit <= 0
    ) {
      errorMessage =
        "Please provide a valid owner, repository, and contributor count.";
      return;
    }

    activeController?.abort();
    const controller = new AbortController();
    activeController = controller;

    loading = true;
    errorMessage = "";
    progressEntries = [];
    gitEntryLookup.clear();
    highlightedContributor = null;
    summaries = [];
    selectedIndex = 0;
    batchStatus = null;
    await tick();
    chartStrip?.scrollTo({ left: 0, behavior: "auto" });

    try {
      const response = await fetch("/api/contribs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          owner: trimmedOwner,
          repo: trimmedRepo,
          limit: contributorLimit,
          excludeBots: false,
          topStarred: includeTopStarred
        }),
        signal: controller.signal,
      });

      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("application/x-ndjson")) {
        const fallback = await response
          .json()
          .catch(() => ({ error: null as string | null }));
        const message =
          fallback?.error ??
          `Request failed with status ${response.status}. Please try again.`;
        throw new Error(message);
      }

      if (!response.body) {
        throw new Error("The server closed the connection unexpectedly.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let receivedComplete = false;
      let receivedError = false;

      const MAX_ENTRIES = 20;

      const appendEntry = (entry: ProgressEntry) => {
        const next = [...progressEntries, entry];
        progressEntries =
          next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next;
      };

      const appendStatus = (message: string) => {
        if (!message) return;
        const trimmed = message.trim();
        if (!trimmed) return;
        const timestamp = Date.now();
        const last = progressEntries[progressEntries.length - 1];
        if (last && last.kind === "status" && last.message === trimmed) {
          progressEntries = [
            ...progressEntries.slice(0, -1),
            { ...last, timestamp }
          ];
          return;
        }

        appendEntry({
          id: `${timestamp}-${Math.random()}`,
          message: trimmed,
          timestamp,
          kind: "status"
        });
      };

      const upsertGitEntry = (command: string, text: string | undefined) => {
        if (!text) {
          return;
        }

        const trimmed = text.trim();
        if (!trimmed) {
          return;
        }

        const timestamp = Date.now();
        const safeCommand = command || "git";
        const label = `[${safeCommand}] ${trimmed}`;
        const existingId = gitEntryLookup.get(safeCommand);
        if (existingId) {
          const existingEntry = progressEntries.find((entry) => entry.id === existingId);
          if (!existingEntry) {
            gitEntryLookup.delete(safeCommand);
            const id = `${timestamp}-${Math.random()}`;
            gitEntryLookup.set(safeCommand, id);
            appendEntry({
              id,
              message: label,
              timestamp,
              kind: "git",
              command: safeCommand
            });
            return;
          }

          const updatedEntry: ProgressEntry = {
            ...existingEntry,
            message: label,
            timestamp
          };

          const filtered = progressEntries.filter((entry) => entry.id !== existingId);
          const next = [...filtered, updatedEntry];
          progressEntries = next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next;
          return;
        }

        const id = `${timestamp}-${Math.random()}`;
        gitEntryLookup.set(safeCommand, id);
        appendEntry({
          id,
          message: label,
          timestamp,
          kind: "git",
          command: safeCommand
        });
      };

      const processLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
      const event = JSON.parse(trimmed) as
        | { type: "status"; message: string }
        | { type: "git"; command: string; stream: "stdout" | "stderr"; text: string }
        | {
            type: "partial";
            summary: SummaryPayload;
            index?: number;
            total?: number;
            description?: string | null;
          }
        | {
            type: "complete";
            summaries?: Array<SummaryPayload & { description?: string | null }>;
          }
        | { type: "result"; summary: SummaryPayload & { description?: string | null } }
        | { type: "error"; message?: string };

          if (event.type === "status") {
            appendStatus(event.message);
          } else if (event.type === "git") {
            upsertGitEntry(event.command, event.text);
          } else if (event.type === "partial") {
            const incoming = event.summary;
            if (incoming) {
              const targetIndex = event.index ?? summaries.length;
              const nextSummaries = [...summaries];
              const nextDescriptions = [...descriptions];
              nextSummaries[targetIndex] = incoming;
              if (event.description !== undefined) {
                nextDescriptions[targetIndex] = event.description ?? undefined;
              }
              const total = event.total ?? nextSummaries.length;
              batchStatus = {
                slug: incoming.slug,
                current: targetIndex + 1,
                total
              };
              summaries = nextSummaries;
              descriptions = nextDescriptions;
              selectedIndex = targetIndex;
              scrollToCard(targetIndex, "auto").catch(() => {});
            }
          } else if (event.type === "complete") {
            summaries = event.summaries ?? [];
            descriptions = (event.summaries ?? []).map((entry) => entry.description ?? undefined);
            receivedComplete = true;
            batchStatus = null;
            if (summaries.length > 0 && selectedIndex >= summaries.length) {
              selectedIndex = summaries.length - 1;
            }
            scrollToCard(selectedIndex).catch(() => {});
          } else if (event.type === "result") {
            summaries = [event.summary];
            descriptions = [event.summary.description ?? undefined];
            selectedIndex = 0;
            receivedComplete = true;
            batchStatus = null;
            scrollToCard(0).catch(() => {});
          } else if (event.type === "error") {
            const message =
              event.message ?? "Unable to gather statistics. Please retry later.";
            errorMessage = message;
            summaries = [];
            descriptions = [];
            batchStatus = null;
            receivedError = true;
          }
        } catch (parseError) {
          console.error("Failed to parse progress message", parseError, { line });
        }
      };

      const processChunk = (chunk: string) => {
        if (!chunk) return;
        buffer += chunk;
        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          processLine(line);
          newlineIndex = buffer.indexOf("\n");
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (value) {
          processChunk(decoder.decode(value, { stream: true }));
        }
      }

      processChunk(decoder.decode());
      if (buffer.trim()) {
        processLine(buffer);
        buffer = "";
      }

      if (!receivedComplete && summaries.length === 0 && !receivedError) {
        throw new Error("The server did not return any results.");
      }
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }
      errorMessage = (error as Error).message;
      summaries = [];
      descriptions = [];
    } finally {
      if (activeController === controller) {
        activeController = null;
        loading = false;
      }
    }
  }

  function useExample(repoExample: { owner: string; repo: string }) {
    includeTopStarred = false;
    owner = repoExample.owner;
    repo = repoExample.repo;
    batchStatus = null;
    progressEntries = [];
    gitEntryLookup.clear();
    descriptions = [];
    void handleSubmit();
  }

  function contributorLink(name: string, profileUrl?: string) {
    if (profileUrl) {
      return profileUrl;
    }

    const query = encodeURIComponent(name);
    return `${GITHUB_BASE_URL}/search?q=${query}&type=users`;
  }

  function intervalLabel(interval: AggregationInterval): string {
    return interval === "month" ? "month" : "year";
  }

  function formatRange(summary: SummaryPayload): string {
    const start = new Date(summary.startDate);
    const end = new Date(summary.endDate);

    if (summary.interval === "month") {
      const formatter = new Intl.DateTimeFormat(undefined, {
        month: "short",
        year: "numeric",
      });
      return `${formatter.format(start)} to ${formatter.format(end)}`;
    }

    return `${start.getUTCFullYear()} to ${end.getUTCFullYear()}`;
  }

  function formatPeriodLabel(
    period: SummaryPayload["periods"][number],
    interval: AggregationInterval,
  ): string {
    if (interval === "month") {
      const date = new Date(`${period.start}T00:00:00Z`);
      return new Intl.DateTimeFormat(undefined, {
        month: "short",
        year: "numeric",
      }).format(date);
    }

    return period.label;
  }

  function isAbortError(error: unknown): boolean {
    return (
      error instanceof DOMException
        ? error.name === "AbortError"
        : error instanceof Error && error.name === "AbortError"
    );
  }

  function formatTimestamp(value: number): string {
    const date = new Date(value);
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }).format(date);
  }

  function setHighlight(name: string | null) {
    highlightedContributor = name ? name.trim() : null;
  }

  function filterBots(source: SummaryPayload, shouldExclude: boolean): SummaryPayload {
    if (!shouldExclude) {
      return source;
    }

    const isBot = (name: string) => name.toLowerCase().includes("bot");

    const periods = source.periods.map((period) => ({
      ...period,
      contributors: period.contributors.filter((contributor) => !isBot(contributor.author))
    }));

    const series = source.series.filter((item) => !isBot(item.name));

    return { ...source, periods, series };
  }

  const filteredSummaries = $derived(
    summaries.map((entry) => filterBots(entry, excludeBots))
  );

  const activeSummary = $derived(
    filteredSummaries[selectedIndex] ?? null
  );

  const activeDescription = $derived(descriptions[selectedIndex]);

  $effect(() => {
    if (filteredSummaries.length === 0) {
      selectedIndex = 0;
      return;
    }

    if (selectedIndex > filteredSummaries.length - 1) {
      selectedIndex = filteredSummaries.length - 1;
    }
  });

  async function scrollToCard(index: number, behavior: ScrollBehavior = "smooth") {
    if (!chartStrip) {
      return;
    }

    await tick();
    const width = chartStrip.clientWidth;
    if (width === 0) {
      return;
    }

    chartStrip.scrollTo({ left: width * index, behavior });
  }

  $effect(() => {
    selectedIndex;
    highlightedContributor = null;
    scrollToCard(selectedIndex).catch(() => {});
  });

  function handleChartScroll() {
    if (!chartStrip) {
      return;
    }

    const width = chartStrip.clientWidth;
    if (width === 0) {
      return;
    }

    const nextIndex = Math.round(chartStrip.scrollLeft / width);
    if (Number.isFinite(nextIndex) && nextIndex !== selectedIndex) {
      const clamped = Math.min(Math.max(nextIndex, 0), filteredSummaries.length - 1);
      if (clamped !== selectedIndex) {
        selectedIndex = clamped;
      }
    }
  }

  function handleChartWheel(event: WheelEvent) {
    if (!chartStrip) {
      return;
    }

    if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) {
      event.preventDefault();
      chartStrip.scrollLeft += event.deltaX;
    } else if (event.deltaY !== 0) {
      event.preventDefault();
      chartStrip.scrollLeft += event.deltaY;
    }
  }

  function handleTouchStart(event: TouchEvent) {
    if (!chartStrip || event.touches.length !== 1) {
      return;
    }
    chartStrip.dataset.prevTouchX = String(event.touches[0].clientX);
  }

  function handleTouchMove(event: TouchEvent) {
    if (!chartStrip) {
      return;
    }
    if (event.touches.length !== 1) {
      return;
    }
    event.preventDefault();
    const touch = event.touches[0];
    const prev = chartStrip.dataset.prevTouchX ? Number(chartStrip.dataset.prevTouchX) : touch.clientX;
    const delta = prev - touch.clientX;
    chartStrip.dataset.prevTouchX = String(touch.clientX);
    chartStrip.scrollLeft += delta;
  }

  function handleTouchEnd() {
    if (chartStrip) {
      delete chartStrip.dataset.prevTouchX;
    }
  }
</script>

<div class="page">
  <header>
    <h1>Contributor trends per year</h1>
    <p>
      Clone any GitHub repository, sync its full history, and visualise the most
      prolific contributors for each year.
    </p>
  </header>

  <section class="controls">
    <form onsubmit={handleSubmit}>
      <div class="field">
        <label for="owner">Owner</label>
        <input
          id="owner"
          name="owner"
          bind:value={owner}
          required
          placeholder="torvalds"
        />
      </div>
      <div class="field">
        <label for="repo">Repository</label>
        <input
          id="repo"
          name="repo"
          bind:value={repo}
          required
          placeholder="linux"
          disabled={includeTopStarred}
        />
      </div>
      <div class="field">
        <label for="limit">Top contributors per year</label>
        <input
          id="limit"
          name="limit"
          type="number"
          bind:value={limit}
          min="1"
          max="50"
          step="1"
          required
        />
      </div>
      <div class="field field--checkbox">
        <label for="include-top-starred">
          <input
            id="include-top-starred"
            name="include-top-starred"
            type="checkbox"
            bind:checked={includeTopStarred}
            disabled={!owner.trim()}
            onchange={() => {
              if (includeTopStarred) {
                repo = "";
              }
              progressEntries = [];
              gitEntryLookup.clear();
              summaries = [];
              selectedIndex = 0;
              highlightedContributor = null;
              batchStatus = null;
              if (includeTopStarred) {
                void handleSubmit();
              }
            }}
          />
          <span>{topStarredLabel}</span>
        </label>
      </div>
      <div class="field field--checkbox">
        <label for="exclude-bots">
          <input
            id="exclude-bots"
            name="exclude-bots"
            type="checkbox"
            bind:checked={excludeBots}
            onchange={() => setHighlight(null)}
          />
          <span>Hide bot accounts</span>
      </label>
    </div>
    {#if batchStatus}
      <p class="batch-status" aria-live="polite">
        Handling <code>{batchStatus.slug}</code> {batchStatus.current}/{batchStatus.total}
      </p>
    {/if}
    <div class="actions">
        <button type="submit" disabled={loading}>
          {#if loading}
            <span class="spinner" aria-hidden="true"></span>
            <span>
              {progressEntries.length
                ? progressEntries[progressEntries.length - 1].message
                : "Working..."}
            </span>
          {:else}
            <span>Generate chart</span>
          {/if}
        </button>
      </div>
    </form>

    <div class="examples">
      <p>Try one of these featured repositories:</p>
      <div class="example-buttons">
        {#each examples as example}
          <button
            type="button"
            onclick={() => useExample(example)}
            disabled={loading || includeTopStarred}
          >
            {example.owner}/{example.repo}
          </button>
        {/each}
      </div>
    </div>

    {#if progressEntries.length > 0 && loading}
      <div class="progress" in:fade={{ duration: 200 }} out:fade={{ duration: 200 }}>
        <p>Progress updates</p>
        <ul>
          {#each progressEntries as entry, index}
            <li class:latest={index === progressEntries.length - 1}>
              <span class="timestamp">{formatTimestamp(entry.timestamp)}</span>
              <span>{entry.message}</span>
            </li>
          {/each}
        </ul>
      </div>
    {/if}
  </section>

  {#if errorMessage}
    <div class="error" role="alert">{errorMessage}</div>
  {/if}

  <section class="chart">
  {#if filteredSummaries.length === 0}
    <div class="chart-card single">
      <ContributionChart
        {loading}
        series={activeSummary?.series ?? []}
          periods={activeSummary?.periods ?? []}
          interval={activeSummary?.interval ?? "year"}
          highlighted={highlightedContributor}
          on:highlight={(event: CustomEvent<string | null>) =>
            setHighlight(event.detail ?? null)}
        />
      </div>
    {:else}
      <div
        class="chart-strip"
        bind:this={chartStrip}
        onscroll={handleChartScroll}
        onwheel={handleChartWheel}
        ontouchstart={handleTouchStart}
        ontouchmove={handleTouchMove}
        ontouchend={handleTouchEnd}
        ontouchcancel={handleTouchEnd}
      >
        {#each filteredSummaries as item, index}
          <article class="chart-card" class:active={index === selectedIndex}>
            <header class="chart-card__header">
              <span class="chart-card__index">{index + 1}/{filteredSummaries.length}</span>
              <span class="chart-card__slug">{item.slug}</span>
            </header>
            <ContributionChart
              loading={false}
              series={item.series}
              periods={item.periods}
              interval={item.interval}
              highlighted={index === selectedIndex ? highlightedContributor : null}
              on:highlight={(event: CustomEvent<string | null>) => {
                if (index === selectedIndex) {
                  setHighlight(event.detail ?? null);
                }
              }}
            />
          </article>
        {/each}
      </div>
    {/if}
  </section>
  {#if filteredSummaries.length > 1}
    <p class="chart-hint">Swipe horizontally or use trackpad scroll to pan between charts.</p>
  {/if}

  {#if activeSummary}
    <section class="summary">
      <h2>
        <a
          href={`${GITHUB_BASE_URL}/${activeSummary.slug}`}
          target="_blank"
          rel="noreferrer noopener"
        >
          {activeSummary.slug}
        </a>
      </h2>
      {#if activeDescription}
        <p class="summary-tagline">{activeDescription}</p>
      {/if}
      <p>
        Tracking commits from {formatRange(activeSummary)}, highlighting the top {limit}
        contributors for each
        {intervalLabel(activeSummary.interval)}.
      </p>
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>{activeSummary.interval === "month" ? "Month" : "Year"}</th>
              <th>Top contributors</th>
            </tr>
          </thead>
          <tbody>
            {#each activeSummary.periods as period}
              <tr>
                <td>{formatPeriodLabel(period, activeSummary.interval)}</td>
                <td>
                  {#if period.contributors.length === 0}
                    <span class="muted">No commits</span>
                  {:else}
                    <ul>
                      {#each period.contributors as contributor}
                        <li
                          class:active={
                            highlightedContributor &&
                            highlightedContributor.toLowerCase() === contributor.author.toLowerCase()
                          }
                          onmouseenter={() => setHighlight(contributor.author)}
                          onmouseleave={() => setHighlight(null)}
                        >
                          <a
                            href={contributorLink(
                              contributor.author,
                              contributor.profileUrl,
                            )}
                            target="_blank"
                            rel="noreferrer noopener"
                            onfocus={() => setHighlight(contributor.author)}
                            onblur={() => setHighlight(null)}
                          >
                            {contributor.author} ({contributor.commits})
                          </a>
                        </li>
                      {/each}
                    </ul>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>
  {/if}
</div>

<style>
  :global(body) {
    font-family:
      system-ui,
      -apple-system,
      BlinkMacSystemFont,
      "Segoe UI",
      sans-serif;
    margin: 0;
    color: #1f1f1f;
    background: #f7f7f8;
  }

  .page {
    max-width: 1100px;
    margin: 0 auto;
    padding: 2.5rem 1.5rem 4rem;
    display: grid;
    gap: 2.5rem;
  }

  header h1 {
    margin: 0 0 0.5rem 0;
    font-size: clamp(2rem, 4vw, 2.8rem);
  }

  header p {
    margin: 0;
    font-size: 1rem;
    max-width: 48rem;
    color: #444;
  }

  .controls {
    background: #fff;
    padding: 1.5rem;
    border-radius: 16px;
    box-shadow: 0 20px 40px rgba(15, 23, 42, 0.08);
    display: grid;
    gap: 1.5rem;
  }

  form {
    display: grid;
    gap: 1.25rem;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    align-items: end;
  }

  .field {
    display: grid;
    gap: 0.5rem;
  }

  label {
    font-weight: 600;
    font-size: 0.9rem;
  }

  input {
    padding: 0.7rem 0.9rem;
    border-radius: 0.75rem;
    border: 1px solid rgba(0, 0, 0, 0.15);
    font-size: 1rem;
    transition:
      border-color 0.2s ease,
      box-shadow 0.2s ease;
  }

  .field--checkbox {
    align-self: center;
  }

  .field--checkbox label {
    font-weight: 600;
    font-size: 0.9rem;
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
  }

  .field--checkbox input[type="checkbox"] {
    width: 1.1rem;
    height: 1.1rem;
  }

  input:focus {
    outline: none;
    border-color: #2563eb;
    box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.2);
  }

  .actions {
    display: flex;
    justify-content: flex-start;
  }

  button[type="submit"] {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem 1.5rem;
    border-radius: 999px;
    border: none;
    background: #1d4ed8;
    color: #fff;
    font-size: 1rem;
    font-weight: 600;
    cursor: pointer;
    transition:
      transform 0.15s ease,
      box-shadow 0.15s ease;
  }

  button[type="submit"]:hover {
    transform: translateY(-1px);
    box-shadow: 0 12px 24px rgba(29, 78, 216, 0.2);
  }

  button[type="submit"][disabled] {
    opacity: 0.6;
    cursor: pointer;
    transform: none;
    box-shadow: none;
  }

  .spinner {
    width: 1.1rem;
    height: 1.1rem;
    border-radius: 999px;
    border: 2px solid rgba(255, 255, 255, 0.35);
    border-left-color: #fff;
    animation: spin 0.9s linear infinite;
  }

  .examples {
    display: grid;
    gap: 0.5rem;
    color: #555;
  }

  .progress {
    background: #f1f5f9;
    border-radius: 12px;
    padding: 1rem 1.25rem;
    display: grid;
    gap: 0.5rem;
  }

  .progress p {
    margin: 0;
    font-weight: 600;
    font-size: 0.9rem;
    color: #1f2937;
  }

  .progress ul {
    margin: 0;
    padding-left: 1.1rem;
    display: grid;
    gap: 0.35rem;
    font-size: 0.9rem;
    color: #374151;
  }

  .progress li.latest {
    color: #1d4ed8;
    font-weight: 600;
  }

  .progress li {
    display: flex;
    gap: 0.4rem;
    align-items: baseline;
  }

  .timestamp {
    font-variant-numeric: tabular-nums;
    color: #1f2937;
    opacity: 0.7;
  }

  .example-buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .examples button {
    border: none;
    border-radius: 999px;
    padding: 0.5rem 1.25rem;
    font-size: 0.95rem;
    background: rgba(37, 99, 235, 0.08);
    color: #1d4ed8;
    cursor: pointer;
    transition: background 0.2s ease;
  }

  .examples button:hover {
    background: rgba(37, 99, 235, 0.18);
  }

  .examples button:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .batch-status {
    margin: 0;
    font-size: 0.9rem;
    color: #1f2937;
  }

  .chart {
    background: #fff;
    padding: 1.5rem;
    border-radius: 16px;
    box-shadow: 0 20px 40px rgba(15, 23, 42, 0.08);
    overflow: hidden;
  }

  .chart-strip {
    display: flex;
    overflow-x: auto;
    gap: 1.5rem;
    scroll-snap-type: x mandatory;
    padding-bottom: 0.5rem;
  }

  .chart-strip::-webkit-scrollbar {
    height: 8px;
  }

  .chart-strip::-webkit-scrollbar-thumb {
    background: rgba(30, 64, 175, 0.4);
    border-radius: 999px;
  }

  .chart-card {
    flex: 0 0 100%;
    scroll-snap-align: start;
    display: grid;
    gap: 0.75rem;
  }

  .chart-card.single {
    flex: 1;
  }

  .chart-card__header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 0.75rem;
  }

  .chart-card__index {
    font-size: 0.85rem;
    font-weight: 600;
    color: #1d4ed8;
  }

  .chart-card__slug {
    font-weight: 600;
    font-size: 1rem;
    color: #111827;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chart-card.active .chart-card__slug {
    color: #1d4ed8;
  }

  .chart-hint {
    margin: 0.35rem 0 0;
    font-size: 0.85rem;
    color: #4b5563;
    text-align: right;
  }

  .error {
    background: rgba(220, 38, 38, 0.1);
    color: #991b1b;
    padding: 1rem 1.5rem;
    border-radius: 12px;
    font-weight: 500;
  }

  .summary {
    background: #fff;
    padding: 1.5rem;
    border-radius: 16px;
    box-shadow: 0 20px 40px rgba(15, 23, 42, 0.08);
    display: grid;
    gap: 1rem;
  }

  .summary h2 {
    margin: 0;
    font-size: 1.5rem;
  }

  .summary-tagline {
    margin: 0;
    color: #374151;
    font-size: 0.95rem;
  }

  .summary p {
    margin: 0;
    color: #525252;
  }

  .table-container {
    overflow-x: auto;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.95rem;
  }

  th,
  td {
    text-align: left;
    padding: 0.6rem 0.5rem;
    vertical-align: top;
  }

  thead {
    background: rgba(37, 99, 235, 0.08);
  }

  tr:nth-child(even) td {
    background: rgba(0, 0, 0, 0.02);
  }

  td ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.25rem;
  }

  td li {
    border-radius: 6px;
    transition: background 0.2s ease, color 0.2s ease;
  }

  td li.active {
    background: rgba(37, 99, 235, 0.12);
  }

  td li.active a {
    color: #1d4ed8;
    font-weight: 600;
  }

  .muted {
    color: #888;
  }

	@keyframes spin {
		from {
			transform: rotate(0deg);
		}
		to {
			transform: rotate(360deg);
		}
	}

	@media (max-width: 720px) {
		.chart,
		.summary,
		.controls {
			padding: 1.1rem;
			border-radius: 12px;
		}
  }
</style>
