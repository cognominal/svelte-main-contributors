<script lang="ts">
  import ContributionChart from "$lib/components/ContributionChart.svelte";
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
  let summary = $state<SummaryPayload | null>(null);
  let progressMessages = $state<string[]>([]);
  let activeController: AbortController | null = null;
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
      !trimmedOwner ||
      !trimmedRepo ||
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
    progressMessages = [];

    try {
      const response = await fetch("/api/contribs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          owner: trimmedOwner,
          repo: trimmedRepo,
          limit: contributorLimit,
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
      let receivedResult = false;
      let receivedError = false;

      const appendStatus = (message: string) => {
        if (!message) return;
        const trimmed = message.trim();
        if (!trimmed) return;
        if (progressMessages[progressMessages.length - 1] === trimmed) {
          return;
        }
        const next = [...progressMessages, trimmed];
        const maxEntries = 20;
        progressMessages =
          next.length > maxEntries ? next.slice(next.length - maxEntries) : next;
      };

      const processLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          const event = JSON.parse(trimmed) as
            | { type: "status"; message: string }
            | { type: "git"; command: string; stream: "stdout" | "stderr"; text: string }
            | { type: "result"; summary: SummaryPayload }
            | { type: "error"; message?: string };

          if (event.type === "status") {
            appendStatus(event.message);
          } else if (event.type === "git") {
            const label = `[${event.command}] ${event.text}`.trim();
            appendStatus(label);
          } else if (event.type === "result") {
            summary = event.summary;
            receivedResult = true;
          } else if (event.type === "error") {
            const message =
              event.message ?? "Unable to gather statistics. Please retry later.";
            errorMessage = message;
            summary = null;
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

      if (!receivedResult && !receivedError) {
        throw new Error("The server did not return any results.");
      }
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }
      errorMessage = (error as Error).message;
      summary = null;
    } finally {
      if (activeController === controller) {
        activeController = null;
        loading = false;
      }
    }
  }

  function useExample(repoExample: { owner: string; repo: string }) {
    owner = repoExample.owner;
    repo = repoExample.repo;
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
      <div class="actions">
        <button type="submit" disabled={loading}>
          {#if loading}
            <span class="spinner" aria-hidden="true"></span>
            <span>
              {progressMessages.length
                ? progressMessages[progressMessages.length - 1]
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
          <button type="button" onclick={() => useExample(example)} disabled={loading}>
            {example.owner}/{example.repo}
          </button>
        {/each}
      </div>
    </div>

    {#if progressMessages.length > 0 && !summary}
      <div class="progress">
        <p>Progress updates</p>
        <ul>
          {#each progressMessages as message, index}
            <li class:latest={index === progressMessages.length - 1}>{message}</li>
          {/each}
        </ul>
      </div>
    {/if}
  </section>

  {#if errorMessage}
    <div class="error" role="alert">{errorMessage}</div>
  {/if}

  <section class="chart">
    <ContributionChart
      {loading}
      series={summary?.series ?? []}
      periods={summary?.periods ?? []}
      interval={summary?.interval ?? "year"}
    />
  </section>

  {#if summary}
    <section class="summary">
      <h2>
        <a
          href={`${GITHUB_BASE_URL}/${summary.slug}`}
          target="_blank"
          rel="noreferrer noopener"
        >
          {summary.slug}
        </a>
      </h2>
      <p>
        Tracking commits from {formatRange(summary)}, highlighting the top {limit}
        contributors for each
        {intervalLabel(summary.interval)}.
      </p>
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>{summary.interval === "month" ? "Month" : "Year"}</th>
              <th>Top contributors</th>
            </tr>
          </thead>
          <tbody>
            {#each summary.periods as period}
              <tr>
                <td>{formatPeriodLabel(period, summary.interval)}</td>
                <td>
                  {#if period.contributors.length === 0}
                    <span class="muted">No commits</span>
                  {:else}
                    <ul>
                      {#each period.contributors as contributor}
                        <li>
                          <a
                            href={contributorLink(
                              contributor.author,
                              contributor.profileUrl,
                            )}
                            target="_blank"
                            rel="noreferrer noopener"
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
    cursor: progress;
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

  .chart {
    background: #fff;
    padding: 1.5rem;
    border-radius: 16px;
    box-shadow: 0 20px 40px rgba(15, 23, 42, 0.08);
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
