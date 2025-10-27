<script lang="ts">
  import ContributionChart from "$lib/components/ContributionChart.svelte";
  import { fade } from "svelte/transition";
  import { tick, onMount } from "svelte";
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
  let excludeBots = $state(true);
  let chartStrip = $state<HTMLDivElement | null>(null);
  let pointerDragging = $state(false);
  let pointerDrag: { id: number; startX: number; scrollLeft: number } | null = null;
  let batchStatus = $state<{ slug: string; current: number; total: number } | null>(null);
  let descriptions = $state<Array<string | undefined>>([]);
  let ownerSuggestions = $state<string[]>([]);
  let ownerSuggestionNote = $state<string | null>(null);
  let ownerSuggestionIndex = $state(-1);
  let ownerValidationState = $state<"idle" | "pending" | "valid" | "invalid">("idle");
  let repoSuggestions = $state<string[]>([]);
  let repoSuggestionNote = $state<string | null>(null);
  let repoSuggestionIndex = $state(-1);
  let ownerInputEl: HTMLInputElement | null = null;
  let repoInputEl: HTMLInputElement | null = null;
  let ownerFieldEl: HTMLDivElement | null = null;
  let repoFieldEl: HTMLDivElement | null = null;
  let repoValidationState = $state<"idle" | "pending" | "valid" | "invalid">("idle");
  const GITHUB_BASE_URL = "https://github.com";
  let ownerSuggestionAbort: AbortController | null = null;
  let repoSuggestionAbort: AbortController | null = null;
  let ownerValidationAbort: AbortController | null = null;
  let repoValidationAbort: AbortController | null = null;
  let ownerSuggestionDebounce: ReturnType<typeof setTimeout> | undefined;
  let ownerValidationDebounce: ReturnType<typeof setTimeout> | undefined;
  let repoSuggestionDebounce: ReturnType<typeof setTimeout> | undefined;
  let repoValidationDebounce: ReturnType<typeof setTimeout> | undefined;

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
    const topStarred = trimmedRepo.length === 0;
    const contributorLimit = Number(limit);

    if (!trimmedOwner) {
      errorMessage =
        "Please provide a valid owner, repository, and contributor count.";
      return;
    }

    if (ownerValidationState !== "valid") {
      const ownerOk = await validateOwner(trimmedOwner);
      if (!ownerOk) {
        errorMessage =
          "Please provide a valid owner, repository, and contributor count.";
        return;
      }
    }

    if (!topStarred && repoValidationState !== "valid") {
      const repoOk = await validateRepo(trimmedOwner, trimmedRepo);
      if (!repoOk) {
        errorMessage =
          "Please provide a valid owner, repository, and contributor count.";
        return;
      }
    }

    if (
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
    ownerSuggestions = [];
    ownerSuggestionNote = null;
    repoSuggestions = [];
    repoSuggestionNote = null;
    ownerSuggestionIndex = -1;
    repoSuggestionIndex = -1;
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
          topStarred
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
    owner = repoExample.owner;
    repo = repoExample.repo;
    ownerValidationState = "valid";
    ownerValidationAbort?.abort();
    if (ownerValidationDebounce) {
      clearTimeout(ownerValidationDebounce);
      ownerValidationDebounce = undefined;
    }
    repoValidationAbort?.abort();
    if (repoValidationDebounce) {
      clearTimeout(repoValidationDebounce);
      repoValidationDebounce = undefined;
    }
    repoValidationState = "valid";
    batchStatus = null;
    progressEntries = [];
    gitEntryLookup.clear();
    descriptions = [];
    ownerSuggestions = [];
    ownerSuggestionNote = null;
    repoSuggestions = [];
    repoSuggestionNote = null;
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

  const ownerIsValid = $derived(ownerValidationState === "valid");
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

  function handlePointerDown(event: PointerEvent) {
    if (!chartStrip || event.button !== 0) {
      return;
    }
    if (event.pointerType !== "mouse" && event.pointerType !== "pen") {
      return;
    }
    pointerDrag = {
      id: event.pointerId,
      startX: event.clientX,
      scrollLeft: chartStrip.scrollLeft
    };
    chartStrip.setPointerCapture?.(event.pointerId);
    pointerDragging = true;
    event.preventDefault();
  }

  function handlePointerMove(event: PointerEvent) {
    if (!chartStrip || !pointerDrag || event.pointerId !== pointerDrag.id) {
      return;
    }
    event.preventDefault();
    const delta = event.clientX - pointerDrag.startX;
    chartStrip.scrollLeft = pointerDrag.scrollLeft - delta;
  }

  function endPointerDrag(event: PointerEvent) {
    if (!chartStrip || !pointerDrag || event.pointerId !== pointerDrag.id) {
      return;
    }
    chartStrip.releasePointerCapture?.(event.pointerId);
    pointerDrag = null;
    pointerDragging = false;
  }

  function handlePointerUp(event: PointerEvent) {
    endPointerDrag(event);
  }

  function handlePointerLeave(event: PointerEvent) {
    endPointerDrag(event);
  }

  function handlePointerCancel(event: PointerEvent) {
    endPointerDrag(event);
  }

  function abortOwnerSuggestions() {
    ownerSuggestionAbort?.abort();
    ownerSuggestionAbort = null;
  }

  function abortRepoSuggestions() {
    repoSuggestionAbort?.abort();
    repoSuggestionAbort = null;
  }

  function resetOwnerSuggestions() {
    ownerSuggestions = [];
    ownerSuggestionNote = null;
    ownerSuggestionIndex = -1;
  }

  function resetRepoSuggestions() {
    repoSuggestions = [];
    repoSuggestionNote = null;
    repoSuggestionIndex = -1;
  }

  async function fetchJSON<T>(url: string, signal: AbortSignal): Promise<T> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json"
    };
    if (import.meta.env.VITE_GITHUB_TOKEN) {
      headers.Authorization = `Bearer ${import.meta.env.VITE_GITHUB_TOKEN}`;
    }

    const response = await fetch(url, { headers, signal });
    if (!response.ok) {
      throw new Error(`GitHub request failed (${response.status})`);
    }
    return (await response.json()) as T;
  }

  function handleOwnerInput(event: Event) {
    const value = (event.currentTarget as HTMLInputElement).value.trim();
    owner = value;
    resetOwnerSuggestions();
    abortOwnerSuggestions();
    abortRepoSuggestions();
    resetRepoSuggestions();
    repoValidationAbort?.abort();
    if (repoValidationDebounce) {
      clearTimeout(repoValidationDebounce);
      repoValidationDebounce = undefined;
    }
    repoValidationState = "idle";
    repoSuggestionIndex = -1;
    ownerValidationState = value.length >= 3 ? "pending" : "idle";
    ownerValidationAbort?.abort();
    if (ownerSuggestionDebounce) {
      clearTimeout(ownerSuggestionDebounce);
    }
    if (ownerValidationDebounce) {
      clearTimeout(ownerValidationDebounce);
    }
    if (value.length < 3) {
      ownerValidationState = "idle";
      return;
    }
    ownerSuggestionDebounce = setTimeout(() => {
      void loadOwnerSuggestions(value);
    }, 200);
    ownerValidationDebounce = setTimeout(() => {
      void validateOwner(value);
    }, 200);
  }

  async function loadOwnerSuggestions(query: string) {
    abortOwnerSuggestions();
    const controller = new AbortController();
    ownerSuggestionAbort = controller;
    try {
      const data = await fetchJSON<{
        total_count: number;
        items: Array<{ login: string }>;
      }>(
        `https://api.github.com/search/users?q=${encodeURIComponent(`${query} in:login`)}&per_page=20`,
        controller.signal
      );
      ownerSuggestions = data.items.map((item) => item.login);
      ownerSuggestionIndex = -1;
      ownerSuggestionNote = data.total_count > 20 ? "Type more characters to refine results." : null;
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        ownerSuggestionNote = "Failed to load owner suggestions.";
      }
    }
  }

  function scrollSuggestionIntoView(kind: "owner" | "repo", index: number) {
    if (index < 0 || typeof document === "undefined") {
      return;
    }
    const id = kind === "owner" ? `owner-suggestion-${index}` : `repo-suggestion-${index}`;
    document.getElementById(id)?.scrollIntoView({ block: "nearest" });
  }

  async function handleOwnerKeyDown(event: KeyboardEvent) {
    if (event.key === "ArrowDown" && ownerSuggestions.length > 0) {
      event.preventDefault();
      const next = ownerSuggestionIndex + 1;
      ownerSuggestionIndex =
        next >= ownerSuggestions.length ? 0 : next;
      scrollSuggestionIntoView("owner", ownerSuggestionIndex);
      return;
    }
    if (event.key === "ArrowUp" && ownerSuggestions.length > 0) {
      event.preventDefault();
      const next = ownerSuggestionIndex - 1;
      ownerSuggestionIndex =
        next < 0 ? ownerSuggestions.length - 1 : next;
      scrollSuggestionIntoView("owner", ownerSuggestionIndex);
      return;
    }
    if (event.key === "Escape") {
      if (ownerSuggestions.length > 0 || ownerSuggestionNote) {
        event.preventDefault();
        resetOwnerSuggestions();
      }
      return;
    }
    if (event.key === "Tab" && ownerSuggestions.length > 0) {
      event.preventDefault();
      const targetIndex = ownerSuggestionIndex >= 0 ? ownerSuggestionIndex : 0;
      applyOwnerSuggestion(ownerSuggestions[targetIndex]);
      repoInputEl?.focus();
    } else if (event.key === "Enter") {
      const value = owner.trim();
      if (ownerSuggestions.length > 0 && ownerSuggestionIndex >= 0) {
        event.preventDefault();
        applyOwnerSuggestion(ownerSuggestions[ownerSuggestionIndex]);
        return;
      }
      if (value.length >= 3) {
        event.preventDefault();
        if (ownerValidationState !== "valid") {
          const result = await validateOwner(value);
          if (!result) {
            return;
          }
        }
        repo = "";
        resetRepoSuggestions();
        repoValidationAbort?.abort();
        if (repoValidationDebounce) {
          clearTimeout(repoValidationDebounce);
          repoValidationDebounce = undefined;
        }
        repoValidationState = "idle";
        progressEntries = [];
        gitEntryLookup.clear();
        summaries = [];
        descriptions = [];
        selectedIndex = 0;
        highlightedContributor = null;
        batchStatus = null;
        void handleSubmit();
      }
    }
  }

  function applyOwnerSuggestion(login: string) {
    owner = login;
    resetOwnerSuggestions();
    ownerValidationState = "valid";
    ownerValidationAbort?.abort();
    if (ownerValidationDebounce) {
      clearTimeout(ownerValidationDebounce);
      ownerValidationDebounce = undefined;
    }
    repoValidationAbort?.abort();
    if (repoValidationDebounce) {
      clearTimeout(repoValidationDebounce);
      repoValidationDebounce = undefined;
    }
    repoValidationState = "idle";
    repo = "";
    resetRepoSuggestions();
    repoInputEl?.focus();
  }

  function handleRepoInput(event: Event) {
    if (!ownerIsValid) {
      return;
    }
    const value = (event.currentTarget as HTMLInputElement).value.trim();
    const ownerLogin = owner.trim();
    repo = value;
    resetRepoSuggestions();
    abortRepoSuggestions();
    repoSuggestionIndex = -1;
    repoValidationAbort?.abort();
    if (repoValidationDebounce) {
      clearTimeout(repoValidationDebounce);
      repoValidationDebounce = undefined;
    }
    if (repoSuggestionDebounce) {
      clearTimeout(repoSuggestionDebounce);
      repoSuggestionDebounce = undefined;
    }
    if (!value) {
      repoValidationState = "idle";
      return;
    }
    repoValidationState = "pending";
    if (ownerLogin.length === 0) {
      return;
    }
    if (value.length >= 3) {
      repoSuggestionDebounce = setTimeout(() => {
        void loadRepoSuggestions(ownerLogin, value);
      }, 200);
    }
    repoValidationDebounce = setTimeout(() => {
      void validateRepo(ownerLogin, value);
    }, 250);
  }

  function handleRepoFocus() {
    if (!ownerIsValid) {
      return;
    }
    const ownerLogin = owner.trim();
    const value = repo.trim();
    if (!ownerLogin) {
      return;
    }
    if (value.length >= 3) {
      abortRepoSuggestions();
      void loadRepoSuggestions(ownerLogin, value);
    }
    if (value && repoValidationState !== "valid") {
      repoValidationAbort?.abort();
      if (repoValidationDebounce) {
        clearTimeout(repoValidationDebounce);
        repoValidationDebounce = undefined;
      }
      repoValidationState = "pending";
      void validateRepo(ownerLogin, value);
    }
  }

  async function loadRepoSuggestions(ownerLogin: string, prefix: string) {
    abortRepoSuggestions();
    const controller = new AbortController();
    repoSuggestionAbort = controller;
    try {
      const data = await fetchJSON<{
        total_count: number;
        items: Array<{ name: string; full_name: string }>;
      }>(
        `https://api.github.com/search/repositories?q=${encodeURIComponent(`user:${ownerLogin} ${prefix} in:name`)}&per_page=20`,
        controller.signal
      );
      repoSuggestions = data.items
        .filter((item) => item.full_name.startsWith(`${ownerLogin}/`))
        .map((item) => item.name);
      repoSuggestionIndex = -1;
      repoSuggestionNote = data.total_count > 20 ? "Type more characters to refine results." : null;
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        repoSuggestionNote = "Failed to load repository suggestions.";
      }
    }
  }

  function handleRepoKeyDown(event: KeyboardEvent) {
    if (event.key === "ArrowDown" && repoSuggestions.length > 0) {
      event.preventDefault();
      const next = repoSuggestionIndex + 1;
      repoSuggestionIndex =
        next >= repoSuggestions.length ? 0 : next;
      scrollSuggestionIntoView("repo", repoSuggestionIndex);
      return;
    }
    if (event.key === "ArrowUp" && repoSuggestions.length > 0) {
      event.preventDefault();
      const next = repoSuggestionIndex - 1;
      repoSuggestionIndex =
        next < 0 ? repoSuggestions.length - 1 : next;
      scrollSuggestionIntoView("repo", repoSuggestionIndex);
      return;
    }
    if (event.key === "Escape") {
      if (repoSuggestions.length > 0 || repoSuggestionNote) {
        event.preventDefault();
        resetRepoSuggestions();
      }
      return;
    }
    if (event.key === "Tab" && repoSuggestions.length > 0) {
      event.preventDefault();
      const targetIndex = repoSuggestionIndex >= 0 ? repoSuggestionIndex : 0;
      applyRepoSuggestion(repoSuggestions[targetIndex]);
      return;
    }
    if (event.key === "Enter" && repoSuggestions.length > 0 && repoSuggestionIndex >= 0) {
      event.preventDefault();
      applyRepoSuggestion(repoSuggestions[repoSuggestionIndex]);
    }
  }

  function applyRepoSuggestion(name: string) {
    repo = name;
    resetRepoSuggestions();
    repoValidationAbort?.abort();
    if (repoValidationDebounce) {
      clearTimeout(repoValidationDebounce);
      repoValidationDebounce = undefined;
    }
    const ownerLogin = owner.trim();
    if (ownerLogin) {
      repoValidationState = "pending";
      void validateRepo(ownerLogin, name);
    }
  }

  async function validateOwner(login: string): Promise<boolean> {
    if (!login.trim()) {
      ownerValidationState = "idle";
      return false;
    }
    ownerValidationAbort?.abort();
    const controller = new AbortController();
    ownerValidationAbort = controller;
    ownerValidationState = "pending";
    try {
      const response = await fetch(`https://api.github.com/users/${login}`, {
        signal: controller.signal,
        headers: import.meta.env.VITE_GITHUB_TOKEN
          ? {
              Accept: "application/vnd.github+json",
              Authorization: `Bearer ${import.meta.env.VITE_GITHUB_TOKEN}`
            }
          : { Accept: "application/vnd.github+json" }
      });
      if (!response.ok) {
        ownerValidationState = "invalid";
        return false;
      }
      ownerValidationState = "valid";
      return true;
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        return false;
      }
      ownerValidationState = "invalid";
      return false;
    } finally {
      if (ownerValidationAbort === controller) {
        ownerValidationAbort = null;
      }
    }
  }

  async function validateRepo(ownerLogin: string, repoName: string): Promise<boolean> {
    const login = ownerLogin.trim();
    const repoValue = repoName.trim();
    if (!login || !repoValue) {
      repoValidationState = "idle";
      return false;
    }
    repoValidationAbort?.abort();
    const controller = new AbortController();
    repoValidationAbort = controller;
    repoValidationState = "pending";
    try {
      const response = await fetch(`https://api.github.com/repos/${login}/${repoValue}`, {
        signal: controller.signal,
        headers: import.meta.env.VITE_GITHUB_TOKEN
          ? {
              Accept: "application/vnd.github+json",
              Authorization: `Bearer ${import.meta.env.VITE_GITHUB_TOKEN}`
            }
          : { Accept: "application/vnd.github+json" }
      });
      if (!response.ok) {
        repoValidationState = "invalid";
        return false;
      }
      repoValidationState = "valid";
      return true;
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        return false;
      }
      repoValidationState = "invalid";
      return false;
    } finally {
      if (repoValidationAbort === controller) {
        repoValidationAbort = null;
      }
    }
  }

  onMount(() => {
    const handleGlobalPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        (ownerSuggestions.length > 0 || ownerSuggestionNote) &&
        ownerFieldEl &&
        !ownerFieldEl.contains(target)
      ) {
        resetOwnerSuggestions();
      }
      if (
        (repoSuggestions.length > 0 || repoSuggestionNote) &&
        repoFieldEl &&
        !repoFieldEl.contains(target)
      ) {
        resetRepoSuggestions();
      }
    };
    window.addEventListener("pointerdown", handleGlobalPointerDown);
    return () => {
      window.removeEventListener("pointerdown", handleGlobalPointerDown);
    };
  });
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
      <div class="field field--with-suggestions" bind:this={ownerFieldEl}>
        <label for="owner">Owner</label>
        <div class="input-wrapper">
          <input
            id="owner"
            name="owner"
            bind:value={owner}
            required
            placeholder="torvalds"
            bind:this={ownerInputEl}
            oninput={handleOwnerInput}
            onkeydown={handleOwnerKeyDown}
            class:owner-valid={ownerIsValid}
            aria-invalid={ownerValidationState === "invalid"}
            aria-expanded={ownerSuggestions.length > 0 || ownerSuggestionNote ? "true" : "false"}
            aria-controls={ownerSuggestions.length > 0 || ownerSuggestionNote ? "owner-suggestions" : undefined}
            aria-activedescendant={
              ownerSuggestionIndex >= 0 ? `owner-suggestion-${ownerSuggestionIndex}` : undefined
            }
          />
          {#if ownerSuggestions.length > 0 || ownerSuggestionNote}
            <ul class="suggestions" role="listbox" id="owner-suggestions">
              {#each ownerSuggestions as suggestion, index}
                <li>
                  <button
                    type="button"
                    onclick={() => applyOwnerSuggestion(suggestion)}
                    role="option"
                    aria-selected={index === ownerSuggestionIndex}
                    class:active={index === ownerSuggestionIndex}
                    id={`owner-suggestion-${index}`}
                  >
                    {suggestion}
                  </button>
                </li>
              {/each}
              {#if ownerSuggestionNote}
                <li class="suggestions__note">{ownerSuggestionNote}</li>
              {/if}
            </ul>
          {/if}
        </div>
      </div>
      <div class="field field--with-suggestions" bind:this={repoFieldEl}>
        <label for="repo">Repository</label>
        <div class="input-wrapper">
          <input
            id="repo"
            name="repo"
            bind:value={repo}
            placeholder="linux"
            disabled={!ownerIsValid}
            bind:this={repoInputEl}
            oninput={handleRepoInput}
            onkeydown={handleRepoKeyDown}
            onfocus={handleRepoFocus}
            class:repo-valid={repoValidationState === "valid"}
            aria-invalid={repoValidationState === "invalid"}
            aria-expanded={repoSuggestions.length > 0 || repoSuggestionNote ? "true" : "false"}
            aria-controls={repoSuggestions.length > 0 || repoSuggestionNote ? "repo-suggestions" : undefined}
            aria-activedescendant={
              repoSuggestionIndex >= 0 ? `repo-suggestion-${repoSuggestionIndex}` : undefined
            }
          />
          {#if repoSuggestions.length > 0 || repoSuggestionNote}
            <ul class="suggestions" role="listbox" id="repo-suggestions">
              {#each repoSuggestions as suggestion, index}
                <li>
                  <button
                    type="button"
                    onclick={() => applyRepoSuggestion(suggestion)}
                    role="option"
                    aria-selected={index === repoSuggestionIndex}
                    class:active={index === repoSuggestionIndex}
                    id={`repo-suggestion-${index}`}
                  >
                    {suggestion}
                  </button>
                </li>
              {/each}
              {#if repoSuggestionNote}
                <li class="suggestions__note">{repoSuggestionNote}</li>
              {/if}
            </ul>
          {/if}
        </div>
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
    </form>

    <div class="examples">
      <p>Try one of these featured repositories:</p>
      <div class="example-buttons">
        {#each examples as example}
          <button
            type="button"
            onclick={() => useExample(example)}
            disabled={loading}
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
        class:dragging={pointerDragging}
        bind:this={chartStrip}
        onscroll={handleChartScroll}
        onwheel={handleChartWheel}
        onpointerdown={handlePointerDown}
        onpointermove={handlePointerMove}
        onpointerup={handlePointerUp}
        onpointerleave={handlePointerLeave}
        onpointercancel={handlePointerCancel}
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
              {#if descriptions[index]}
                <span class="chart-card__description">{descriptions[index]}</span>
              {/if}
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

  input::placeholder {
    color: rgba(15, 23, 42, 0.45);
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

  .field--with-suggestions .input-wrapper {
    position: relative;
  }

  .field--with-suggestions .input-wrapper input {
    width: 100%;
  }

  .suggestions {
    position: absolute;
    top: calc(100% + 0.35rem);
    left: 0;
    right: 0;
    list-style: none;
    margin: 0;
    padding: 0.35rem 0;
    border: 1px solid rgba(15, 23, 42, 0.1);
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.98);
    display: grid;
    gap: 0.25rem;
    box-shadow: 0 12px 28px rgba(15, 23, 42, 0.18);
    z-index: 10;
    max-height: 14rem;
    overflow-y: auto;
  }

  .suggestions li {
    margin: 0;
    padding: 0;
  }

  .suggestions button {
    width: 100%;
    text-align: left;
    padding: 0.4rem 0.8rem;
    background: transparent;
    border: 0;
    font-size: 0.9rem;
    color: #1f2937;
    cursor: pointer;
  }

  .suggestions button:hover,
  .suggestions button:focus-visible,
  .suggestions button.active {
    background: rgba(37, 99, 235, 0.12);
    outline: none;
  }

  .suggestions__note {
    font-size: 0.8rem;
    color: #4b5563;
    padding: 0.3rem 0.8rem;
  }

  input.owner-valid,
  input.repo-valid {
    font-weight: 700;
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
    cursor: grab;
  }

  .chart-strip::-webkit-scrollbar {
    height: 8px;
  }

  .chart-strip::-webkit-scrollbar-thumb {
    background: rgba(30, 64, 175, 0.4);
    border-radius: 999px;
  }

  .chart-strip.dragging {
    cursor: grabbing;
    user-select: none;
  }

  .chart-strip.dragging * {
    user-select: none;
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

  .chart-card__description {
    display: block;
    font-size: 0.85rem;
    color: #4b5563;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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

	@media (max-width: 720px) {
		.chart,
		.summary,
		.controls {
			padding: 1.1rem;
			border-radius: 12px;
		}
  }
</style>
