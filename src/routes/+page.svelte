<script lang="ts">
  import ContributionChart from "$lib/components/ContributionChart.svelte";
  import { fade } from "svelte/transition";
  import { tick, onMount, onDestroy } from "svelte";
  import { generateThumbnail } from "$lib/thumbnails";
  import type { AggregationInterval, ContributorSeries } from "$lib/types";
  import {
    createAutocomplete,
    isAbortError,
  } from "$lib/autocomplete/completion.svelte";
  import { fetchJSON } from "$lib/autocomplete";
  import { AutocompleteInput } from "$lib/components/autocomplete";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  const ownerMap = data.ownerMap ?? {};
  const LOCAL_SUGGESTION_LIMIT = 20;

  function resolveOwnerKey(candidate: string): string | null {
    const target = candidate.trim().toLowerCase();
    if (!target) {
      return null;
    }
    for (const key of Object.keys(ownerMap)) {
      if (key.toLowerCase() === target) {
        return key;
      }
    }
    return null;
  }

  function localOwnerSuggestions(query: string): string[] {
    const owners = Object.keys(ownerMap);
    if (owners.length === 0) {
      return [];
    }
    const needle = query.trim().toLowerCase();
    const matches = needle
      ? owners.filter((owner) => owner.toLowerCase().startsWith(needle))
      : owners;
    return matches.slice(0, LOCAL_SUGGESTION_LIMIT);
  }

  function localRepoSuggestions(ownerValue: string, query: string): string[] {
    const ownerKey = resolveOwnerKey(ownerValue);
    if (!ownerKey) {
      return [];
    }
    const repos = ownerMap[ownerKey] ?? [];
    const needle = query.trim().toLowerCase();
    const matches = needle
      ? repos.filter((repo) => repo.toLowerCase().startsWith(needle))
      : repos;
    return matches.slice(0, LOCAL_SUGGESTION_LIMIT);
  }

  let owner = $state("");
  let repo = $state("");

  const GITHUB_BASE_URL = "https://github.com";

  const ownerAutocomplete = createAutocomplete(() => owner, {
    fetchSuggestions: async (query, signal) => {
      const trimmed = query.trim();
      const localItems = localOwnerSuggestions(trimmed).map((login) => ({
        login,
      }));
      if (trimmed.length < 3) {
        return {
          items: localItems,
          total_count: localItems.length,
        };
      }
      try {
        const data = await fetchJSON<{
          total_count: number;
          items: Array<{ login: string }>;
        }>(
          `https://api.github.com/search/users?q=${encodeURIComponent(`${query} in:login`)}&per_page=20`,
          signal,
        );
        const seen = new Set(
          localItems.map((item) => item.login.toLowerCase()),
        );
        const remoteItems = data.items
          .filter((item) =>
            item.login.toLowerCase().startsWith(trimmed.toLowerCase()),
          )
          .filter((item) => !seen.has(item.login.toLowerCase()));
        return {
          items: [...localItems, ...remoteItems],
          total_count: localItems.length + remoteItems.length,
        };
      } catch (error) {
        if (!isAbortError(error)) {
          console.error("Owner suggestion lookup failed", error);
        }
        return {
          items: localItems,
          total_count: localItems.length,
        };
      }
    },
    fetchValidation: async (query, signal) => {
      if (resolveOwnerKey(query)) {
        return true;
      }
      if (!query.trim()) {
        return false;
      }
      const response = await fetch(`https://api.github.com/users/${query}`, {
        signal,
        headers: import.meta.env.VITE_GITHUB_TOKEN
          ? {
              Accept: "application/vnd.github+json",
              Authorization: `Bearer ${import.meta.env.VITE_GITHUB_TOKEN}`,
            }
          : { Accept: "application/vnd.github+json" },
      });
      return response.ok;
    },
    onSelect: (value) => {
      const canonical = resolveOwnerKey(value) ?? value;
      owner = canonical;
      repo = "";
      repoAutocomplete.resetSuggestions();
      repoAutocomplete.abortValidation();
      repoAutocomplete.setValidationState("idle");
      repoAutocomplete.inputEl?.focus();
    },
    minLength: 0,
  });

  let ownerExactMatch = $state(false);
  $effect(() => {
    const value = ownerAutocomplete.value.trim();
    if (!value) {
      ownerExactMatch = false;
      return;
    }
    const canonical = resolveOwnerKey(value);
    ownerExactMatch = canonical
      ? canonical.toLowerCase() === value.toLowerCase()
      : false;
  });

  const repoAutocomplete = createAutocomplete(() => repo, {
    fetchSuggestions: async (query, signal) => {
      const ownerLogin = owner.trim();
      if (!ownerLogin) {
        return { items: [], total_count: 0 };
      }
      const localRepos = localRepoSuggestions(ownerLogin, query).map(
        (name) => ({
          name,
          full_name: `${resolveOwnerKey(ownerLogin) ?? ownerLogin}/${name}`,
        }),
      );
      const trimmed = query.trim();
      if (trimmed.length === 0) {
        return {
          items: localRepos,
          total_count: localRepos.length,
        };
      }
      try {
        const resolvedOwner = resolveOwnerKey(ownerLogin) ?? ownerLogin;
        const data = await fetchJSON<{
          total_count: number;
          items: Array<{ name: string; full_name: string }>;
        }>(
          `https://api.github.com/search/repositories?q=${encodeURIComponent(`user:${resolvedOwner} ${query} in:name`)}&per_page=20`,
          signal,
        );
        const filteredItems = data.items.filter(
          (item) =>
            item.full_name.startsWith(`${resolvedOwner}/`) &&
            item.name.toLowerCase().startsWith(trimmed.toLowerCase()),
        );
        const seen = new Set(localRepos.map((item) => item.name.toLowerCase()));
        const remoteItems = filteredItems.filter(
          (item) => !seen.has(item.name.toLowerCase()),
        );
        return {
          items: [...localRepos, ...remoteItems],
          total_count: localRepos.length + remoteItems.length,
        };
      } catch (error) {
        if (!isAbortError(error)) {
          console.error("Repository suggestion lookup failed", error);
        }
        return {
          items: localRepos,
          total_count: localRepos.length,
        };
      }
    },
    fetchValidation: async (query, signal) => {
      const ownerLogin = owner.trim();
      if (!ownerLogin || !query.trim()) {
        return false;
      }
      const resolvedOwner = resolveOwnerKey(ownerLogin) ?? ownerLogin;
      const response = await fetch(
        `https://api.github.com/repos/${resolvedOwner}/${query}`,
        {
          signal,
          headers: import.meta.env.VITE_GITHUB_TOKEN
            ? {
                Accept: "application/vnd.github+json",
                Authorization: `Bearer ${import.meta.env.VITE_GITHUB_TOKEN}`,
              }
            : { Accept: "application/vnd.github+json" },
        },
      );
      return response.ok;
    },
    onSelect: (value) => {
      repo = value;
      repoAutocomplete.abortValidation();
      repoAutocomplete.setValidationState("pending");
      void repoAutocomplete.validate(value);
    },
    minLength: 0,
  });

  // Bind owner and repo to the autocomplete values
  $effect(() => {
    owner = ownerAutocomplete.value;
  });
  $effect(() => {
    repo = repoAutocomplete.value;
  });

  // Expose input elements for parent to bind:this
  let ownerInputEl = ownerAutocomplete.inputEl;
  let repoInputEl = repoAutocomplete.inputEl;
  let ownerFieldEl = ownerAutocomplete.fieldEl;
  let repoFieldEl = repoAutocomplete.fieldEl;

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
        email?: string;
      }>;
    }>;
  }

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
  let pointerDrag: { id: number; startX: number; scrollLeft: number } | null =
    null;
  let batchStatus = $state<{
    slug: string;
    current: number;
    total: number;
  } | null>(null);
  let descriptions = $state<Array<string | undefined>>([]);

  let chartCardElements = $state<Array<HTMLElement | null>>([]);
  let thumbnailUrls = $state<Array<string | null>>([]);
  let thumbnailStatus = $state<Array<"idle" | "pending" | "ready" | "error">>(
    [],
  );
  let storageInfo = $state<{
    gitBytes: number;
    usedBytes: number;
    totalBytes: number;
    availableBytes: number;
  } | null>(null);
  let storageStatus = $state<"idle" | "loading" | "error" | "ready">("idle");
  let storageError = $state<string | null>(null);

  let snapEnabled = $state(true);
  let snapRestoreId: ReturnType<typeof setTimeout> | null = null;
  let scrollAnimationFrame: number | null = null;
  let suppressScrollSync = false;

  const examples = [
    { owner: "torvalds", repo: "linux" },
    { owner: "microsoft", repo: "TypeScript" },
    { owner: "sveltejs", repo: "kit" },
    { owner: "deepseek-ai", repo: "DeepSeek-R1" },
  ];
  onDestroy(() => {
    cancelSnapRestore();
    if (scrollAnimationFrame) {
      cancelAnimationFrame(scrollAnimationFrame);
      scrollAnimationFrame = null;
    }
  });

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

    if (ownerAutocomplete.validationState !== "valid") {
      const ownerOk = await ownerAutocomplete.validate(trimmedOwner);
      if (!ownerOk) {
        errorMessage =
          "Please provide a valid owner, repository, and contributor count.";
        return;
      }
    }

    if (!topStarred && repoAutocomplete.validationState !== "valid") {
      const repoOk = await repoAutocomplete.validate(trimmedRepo);
      if (!repoOk) {
        errorMessage =
          "Please provide a valid owner, repository, and contributor count.";
        return;
      }
    }

    activeController?.abort();
    const controller = new AbortController();
    activeController = controller;

    loading = true;
    errorMessage = "";
    progressEntries = [];
    gitEntryLookup.clear();
    highlightedContributor = null;
    ownerAutocomplete.resetSuggestions();
    repoAutocomplete.resetSuggestions();
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
          topStarred,
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
          next.length > MAX_ENTRIES
            ? next.slice(next.length - MAX_ENTRIES)
            : next;
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
            { ...last, timestamp },
          ];
          return;
        }

        appendEntry({
          id: `${timestamp}-${Math.random()}`,
          message: trimmed,
          timestamp,
          kind: "status",
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
          const existingEntry = progressEntries.find(
            (entry) => entry.id === existingId,
          );
          if (!existingEntry) {
            gitEntryLookup.delete(safeCommand);
            const id = `${timestamp}-${Math.random()}`;
            gitEntryLookup.set(safeCommand, id);
            appendEntry({
              id,
              message: label,
              timestamp,
              kind: "git",
              command: safeCommand,
            });
            return;
          }

          const updatedEntry: ProgressEntry = {
            ...existingEntry,
            message: label,
            timestamp,
          };

          const filtered = progressEntries.filter(
            (entry) => entry.id !== existingId,
          );
          const next = [...filtered, updatedEntry];
          progressEntries =
            next.length > MAX_ENTRIES
              ? next.slice(next.length - MAX_ENTRIES)
              : next;
          return;
        }

        const id = `${timestamp}-${Math.random()}`;
        gitEntryLookup.set(safeCommand, id);
        appendEntry({
          id,
          message: label,
          timestamp,
          kind: "git",
          command: safeCommand,
        });
      };

      const processLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          const event = JSON.parse(trimmed) as
            | { type: "status"; message: string }
            | {
                type: "git";
                command: string;
                stream: "stdout" | "stderr";
                text: string;
              }
            | {
                type: "partial";
                summary: SummaryPayload;
                index?: number;
                total?: number;
                description?: string | null;
              }
            | {
                type: "complete";
                summaries?: Array<
                  SummaryPayload & { description?: string | null }
                >;
              }
            | {
                type: "result";
                summary: SummaryPayload & { description?: string | null };
              }
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
                total,
              };
              summaries = nextSummaries;
              descriptions = nextDescriptions;
              const nextThumbs = [...thumbnailUrls];
              nextThumbs[targetIndex] = null;
              thumbnailUrls = nextThumbs;
              const nextStatuses = [...thumbnailStatus];
              nextStatuses[targetIndex] = "idle";
              thumbnailStatus = nextStatuses;
              selectedIndex = targetIndex;
              scrollToCard(targetIndex, "auto").catch(() => {});
            }
          } else if (event.type === "complete") {
            summaries = event.summaries ?? [];
            descriptions = (event.summaries ?? []).map(
              (entry) => entry.description ?? undefined,
            );
            thumbnailUrls = new Array(summaries.length).fill(null);
            thumbnailStatus = new Array(summaries.length).fill("idle");
            receivedComplete = true;
            batchStatus = null;
            if (summaries.length > 0 && selectedIndex >= summaries.length) {
              selectedIndex = summaries.length - 1;
            }
            scrollToCard(selectedIndex).catch(() => {});
          } else if (event.type === "result") {
            summaries = [event.summary];
            descriptions = [event.summary.description ?? undefined];
            thumbnailUrls = [null];
            thumbnailStatus = ["idle"];
            selectedIndex = 0;
            receivedComplete = true;
            batchStatus = null;
            scrollToCard(0).catch(() => {});
          } else if (event.type === "error") {
            const message =
              event.message ??
              "Unable to gather statistics. Please retry later.";
            errorMessage = message;
            summaries = [];
            descriptions = [];
            thumbnailUrls = [];
            thumbnailStatus = [];
            batchStatus = null;
            receivedError = true;
          }
        } catch (parseError) {
          console.error("Failed to parse progress message", parseError, {
            line,
          });
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
    ownerAutocomplete.setValidationState("valid");
    ownerAutocomplete.abortValidation();
    repoAutocomplete.setValidationState("valid");
    repoAutocomplete.abortValidation();
    batchStatus = null;
    progressEntries = [];
    gitEntryLookup.clear();
    descriptions = [];
    ownerAutocomplete.resetSuggestions();
    repoAutocomplete.resetSuggestions();
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

  function formatTimestamp(value: number): string {
    const date = new Date(value);
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(date);
  }

  function setHighlight(name: string | null) {
    highlightedContributor = name ? name.trim() : null;
  }

  function filterBots(
    source: SummaryPayload,
    shouldExclude: boolean,
  ): SummaryPayload {
    if (!shouldExclude) {
      return source;
    }

    const isBot = (name: string) => name.toLowerCase().includes("bot");

    const periods = source.periods.map((period) => ({
      ...period,
      contributors: period.contributors.filter(
        (contributor) => !isBot(contributor.author),
      ),
    }));

    const series = source.series.filter((item) => !isBot(item.name));

    return { ...source, periods, series };
  }

  const ownerIsValid = $derived(ownerAutocomplete.validationState === "valid");
  const filteredSummaries = $derived(
    summaries.map((entry) => filterBots(entry, excludeBots)),
  );

  const activeSummary = $derived(filteredSummaries[selectedIndex] ?? null);

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

  $effect(() => {
    const count = filteredSummaries.length;
    if (chartCardElements.length !== count) {
      const nextCards = [...chartCardElements];
      nextCards.length = count;
      for (let index = 0; index < count; index += 1) {
        if (!(index in nextCards)) {
          nextCards[index] = null;
        }
      }
      chartCardElements = nextCards;
    }

    if (thumbnailUrls.length !== count) {
      const nextUrls = [...thumbnailUrls];
      nextUrls.length = count;
      for (let index = 0; index < count; index += 1) {
        if (!(index in nextUrls)) {
          nextUrls[index] = null;
        }
      }
      thumbnailUrls = nextUrls;
    }

    if (thumbnailStatus.length !== count) {
      const nextStatus = [...thumbnailStatus];
      nextStatus.length = count;
      for (let index = 0; index < count; index += 1) {
        if (!(index in nextStatus)) {
          nextStatus[index] = "idle";
        }
      }
      thumbnailStatus = nextStatus;
    }
  });

  function stopScrollAnimation() {
    if (scrollAnimationFrame) {
      cancelAnimationFrame(scrollAnimationFrame);
      scrollAnimationFrame = null;
    }
  }

  function getScrollMetrics() {
    if (!chartStrip) {
      return { width: 0, max: 0, bounce: 0 };
    }
    const width = chartStrip.clientWidth;
    const maxIndex = Math.max(filteredSummaries.length - 1, 0);
    const max = width * maxIndex;
    const bounce = width * 0.25;
    return { width, max, bounce };
  }

  function animateScrollTo(
    targetLeft: number,
    duration = 380,
    onComplete?: () => void,
  ) {
    if (!chartStrip) {
      return;
    }
    stopScrollAnimation();
    const start = chartStrip.scrollLeft;
    const distance = targetLeft - start;
    if (Math.abs(distance) < 0.5) {
      chartStrip.scrollLeft = targetLeft;
      onComplete?.();
      return;
    }
    const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
    const startTime = performance.now();

    const step = (now: number) => {
      if (!chartStrip) {
        scrollAnimationFrame = null;
        return;
      }
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = easeOutCubic(progress);
      chartStrip.scrollLeft = start + distance * eased;
      if (progress < 1) {
        scrollAnimationFrame = requestAnimationFrame(step);
      } else {
        scrollAnimationFrame = null;
        onComplete?.();
      }
    };

    scrollAnimationFrame = requestAnimationFrame(step);
  }

  function cancelSnapRestore() {
    if (snapRestoreId) {
      clearTimeout(snapRestoreId);
      snapRestoreId = null;
    }
  }

  async function scrollToCard(
    index: number,
    behavior: ScrollBehavior = "smooth",
  ) {
    if (!chartStrip) {
      return;
    }

    await tick();
    cancelSnapRestore();
    const width = chartStrip.clientWidth;
    if (width === 0) {
      return;
    }

    const targetLeft = width * index;
    snapEnabled = false;
    suppressScrollSync = true;
    if (behavior === "smooth") {
      animateScrollTo(targetLeft, 380, () => {
        snapEnabled = true;
        suppressScrollSync = false;
      });
    } else {
      stopScrollAnimation();
      chartStrip.scrollLeft = targetLeft;
      snapEnabled = true;
      suppressScrollSync = false;
    }
  }

  $effect(() => {
    selectedIndex;
    highlightedContributor = null;
    ownerAutocomplete.resetSuggestions();
    repoAutocomplete.resetSuggestions();
    scrollToCard(selectedIndex).catch(() => {});
  });

  function handleChartScroll() {
    if (suppressScrollSync) {
      return;
    }
    if (!chartStrip) {
      return;
    }

    const width = chartStrip.clientWidth;
    if (width === 0) {
      return;
    }

    const nextIndex = Math.round(chartStrip.scrollLeft / width);
    if (Number.isFinite(nextIndex) && nextIndex !== selectedIndex) {
      const clamped = Math.min(
        Math.max(nextIndex, 0),
        filteredSummaries.length - 1,
      );
      if (clamped !== selectedIndex) {
        selectedIndex = clamped;
      }
    }
  }

  function scheduleSnapRestore() {
    if (filteredSummaries.length <= 1) {
      snapEnabled = true;
      suppressScrollSync = false;
      return;
    }
    cancelSnapRestore();
    if (snapEnabled) {
      snapEnabled = false;
    }
    snapRestoreId = setTimeout(() => {
      snapRestoreId = null;
      if (!chartStrip || filteredSummaries.length === 0) {
        snapEnabled = true;
        suppressScrollSync = false;
        return;
      }
      const { width, max } = getScrollMetrics();
      suppressScrollSync = true;
      if (width > 0) {
        const rawIndex = chartStrip.scrollLeft / width;
        const targetIndex = Math.min(
          Math.max(Math.round(rawIndex), 0),
          filteredSummaries.length - 1,
        );
        if (targetIndex !== selectedIndex) {
          selectedIndex = targetIndex;
        }
        const targetLeft = Math.min(Math.max(width * targetIndex, 0), max);
        animateScrollTo(targetLeft, 420, () => {
          snapEnabled = true;
          suppressScrollSync = false;
        });
      } else {
        snapEnabled = true;
        suppressScrollSync = false;
      }
    }, 180);
  }

  function handleChartWheel(event: WheelEvent) {
    if (!chartStrip) {
      return;
    }

    const { max, bounce } = getScrollMetrics();
    stopScrollAnimation();

    if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) {
      event.preventDefault();
      const next = chartStrip.scrollLeft + event.deltaX;
      chartStrip.scrollLeft = Math.max(-bounce, Math.min(next, max + bounce));
    } else if (event.deltaY !== 0) {
      event.preventDefault();
      const next = chartStrip.scrollLeft + event.deltaY;
      chartStrip.scrollLeft = Math.max(-bounce, Math.min(next, max + bounce));
    }
    scheduleSnapRestore();
  }

  function handleTouchStart(event: TouchEvent) {
    if (!chartStrip || event.touches.length !== 1) {
      return;
    }
    chartStrip.dataset.prevTouchX = String(event.touches[0].clientX);
    stopScrollAnimation();
    scheduleSnapRestore();
  }

  function handleTouchMove(event: TouchEvent) {
    if (!chartStrip) {
      return;
    }
    if (event.touches.length !== 1) {
      return;
    }
    event.preventDefault();
    stopScrollAnimation();
    const touch = event.touches[0];
    const prev = chartStrip.dataset.prevTouchX
      ? Number(chartStrip.dataset.prevTouchX)
      : touch.clientX;
    const delta = prev - touch.clientX;
    chartStrip.dataset.prevTouchX = String(touch.clientX);
    const { max, bounce } = getScrollMetrics();
    const next = chartStrip.scrollLeft + delta;
    chartStrip.scrollLeft = Math.max(-bounce, Math.min(next, max + bounce));
    scheduleSnapRestore();
  }

  function handleTouchEnd() {
    if (chartStrip) {
      delete chartStrip.dataset.prevTouchX;
    }
    scheduleSnapRestore();
  }

  function handlePointerDown(event: PointerEvent) {
    if (!chartStrip || event.button !== 0) {
      return;
    }
    pointerDrag = {
      id: event.pointerId,
      startX: event.clientX,
      scrollLeft: chartStrip.scrollLeft,
    };
    chartStrip.setPointerCapture?.(event.pointerId);
    pointerDragging = true;
    event.preventDefault();
    stopScrollAnimation();
    scheduleSnapRestore();
  }

  function handlePointerMove(event: PointerEvent) {
    if (!chartStrip || !pointerDrag || event.pointerId !== pointerDrag.id) {
      return;
    }
    event.preventDefault();
    const { max, bounce } = getScrollMetrics();
    const delta = event.clientX - pointerDrag.startX;
    const next = pointerDrag.scrollLeft - delta;
    chartStrip.scrollLeft = Math.max(-bounce, Math.min(next, max + bounce));
    scheduleSnapRestore();
  }

  function endPointerDrag(event: PointerEvent) {
    if (!chartStrip || !pointerDrag || event.pointerId !== pointerDrag.id) {
      return;
    }
    chartStrip.releasePointerCapture?.(event.pointerId);
    pointerDrag = null;
    pointerDragging = false;
    scheduleSnapRestore();
  }

  $effect(() => {
    filteredSummaries;
    chartCardElements;
    (async () => {
      await tick();
      for (let index = 0; index < filteredSummaries.length; index += 1) {
        if (thumbnailStatus[index] === "idle" && chartCardElements[index]) {
          const nextStatus = [...thumbnailStatus];
          nextStatus[index] = "pending";
          thumbnailStatus = nextStatus;
          const dataUrl = await generateThumbnail(chartCardElements[index]);
          if (dataUrl) {
            const nextUrls = [...thumbnailUrls];
            nextUrls[index] = dataUrl;
            thumbnailUrls = nextUrls;
            const nextStatus = [...thumbnailStatus];
            nextStatus[index] = "ready";
            thumbnailStatus = nextStatus;
          } else {
            const nextStatus = [...thumbnailStatus];
            nextStatus[index] = "error";
            thumbnailStatus = nextStatus;
          }
        }
      }
    })().catch((error) => console.error(error));
  });

  function handlePointerUp(event: PointerEvent) {
    endPointerDrag(event);
  }

  function handlePointerLeave(event: PointerEvent) {
    endPointerDrag(event);
  }

  function handlePointerCancel(event: PointerEvent) {
    endPointerDrag(event);
  }

  function repositoryName(slug: string): string {
    const parts = slug.split("/");
    return parts.length > 1 ? parts[1] : slug;
  }

  function extractLogin(profileUrl?: string | null): string | null {
    if (!profileUrl) {
      return null;
    }
    try {
      const url = new URL(profileUrl);
      const segments = url.pathname.split("/").filter(Boolean);
      if (segments.length === 0) {
        return null;
      }
      return segments[segments.length - 1];
    } catch {
      return null;
    }
  }

  function resolvedProfileUrl(
    name: string,
    fallback?: string | null,
  ): string | undefined {
    if (fallback) {
      return fallback;
    }
    const summary = activeSummary;
    if (!summary) {
      return undefined;
    }
    const lower = name.toLowerCase();
    for (const period of summary.periods) {
      for (const contributor of period.contributors) {
        if (
          contributor.profileUrl &&
          contributor.author.toLowerCase() === lower
        ) {
          return contributor.profileUrl;
        }
      }
    }
    return undefined;
  }

  function avatarSource(name: string, fallback?: string | null): string | null {
    const profileUrl = resolvedProfileUrl(name, fallback) ?? null;
    const login = extractLogin(profileUrl);
    if (!login) {
      return null;
    }
    return `https://avatars.githubusercontent.com/${encodeURIComponent(login)}?s=96&v=4`;
  }

  function resolveBackgroundColor(element: HTMLElement | null): string {
    let current: HTMLElement | null = element;
    while (current) {
      const color = getComputedStyle(current).backgroundColor;
      if (color && color !== "rgba(0, 0, 0, 0)" && color !== "transparent") {
        return color;
      }
      current = current.parentElement;
    }
    return "#ffffff";
  }

  function formatBytes(value: number): string {
    if (!Number.isFinite(value) || value <= 0) {
      return "0B";
    }
    const units = ["B", "KB", "MB", "GB", "TB", "PB"];
    const exponent = Math.min(
      units.length - 1,
      Math.floor(Math.log(value) / Math.log(1024)),
    );
    const scaled = value / 1024 ** exponent;
    const display = scaled >= 10 ? scaled.toFixed(1) : scaled.toFixed(1);
    return `${display}${units[exponent]}`;
  }

  async function loadStorageInfo() {
    if (storageStatus === "loading") {
      return;
    }
    storageStatus = "loading";
    storageError = null;
    try {
      const response = await fetch("/api/storage");
      if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`);
      }
      const data = (await response.json()) as {
        gitBytes: number;
        usedBytes: number;
        totalBytes: number;
        availableBytes: number;
      };
      storageInfo = data;
      storageStatus = "ready";
    } catch (error) {
      storageStatus = "error";
      storageError =
        error instanceof Error
          ? error.message
          : "Unable to load storage information.";
    }
  }

  function chartRef(node: HTMLElement, index: number) {
    let currentIndex = index;
    const next = [...chartCardElements];
    next[currentIndex] = node;
    chartCardElements = next;

    return {
      destroy() {
        const updated = [...chartCardElements];
        if (updated[currentIndex] === node) {
          updated[currentIndex] = null;
          chartCardElements = updated;
        }
      },
      update(nextIndex: number) {
        if (nextIndex === currentIndex) {
          return;
        }
        const updated = [...chartCardElements];
        if (updated[currentIndex] === node) {
          updated[currentIndex] = null;
        }
        updated[nextIndex] = node;
        chartCardElements = updated;
        currentIndex = nextIndex;
      },
    };
  }

  onMount(() => {
    const focusHandle = requestAnimationFrame(() => {
      ownerAutocomplete.inputEl?.focus();
      ownerAutocomplete.handleFocus();
    });
    void loadStorageInfo();
    return () => {
      cancelAnimationFrame(focusHandle);
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
    <form
      class="grid gap-5 sm:grid-cols-2 lg:grid-cols-3"
      onsubmit={handleSubmit}
    >
      <div class="sm:col-span-2 lg:col-span-3">
        {#if owner.trim().length >= 0 && owner.trim().length < 3}
          <p class="text-sm font-medium text-slate-600">
            cached results. type more than 2 chars to get the github completion
          </p>
        {:else}
          <p class="text-sm text-slate-400">&nbsp;</p>
        {/if}
      </div>
      <AutocompleteInput
        id="owner"
        label="Owner"
        placeholder="e.g. sveltejs"
        disabled={loading}
        value={ownerAutocomplete.value}
        suggestions={ownerAutocomplete.suggestions}
        suggestionNote={ownerAutocomplete.suggestionNote}
        validationState={ownerAutocomplete.validationState}
        handleInput={ownerAutocomplete.handleInput}
        handleKeyDown={ownerAutocomplete.handleKeyDown}
        applySuggestion={ownerAutocomplete.applySuggestion}
        resetSuggestions={ownerAutocomplete.resetSuggestions}
        handleFocus={ownerAutocomplete.handleFocus}
        bind:inputEl={ownerAutocomplete.inputEl}
        bind:fieldEl={ownerAutocomplete.fieldEl}
        highlightMatch={ownerExactMatch}
        suggestionsPending={ownerAutocomplete.suggestionsPending}
      />
      <AutocompleteInput
        id="repo"
        label="Repository"
        placeholder="e.g. svelte"
        disabled={loading}
        value={repoAutocomplete.value}
        suggestions={repoAutocomplete.suggestions}
        suggestionNote={repoAutocomplete.suggestionNote}
        validationState={repoAutocomplete.validationState}
        handleInput={repoAutocomplete.handleInput}
        handleKeyDown={repoAutocomplete.handleKeyDown}
        applySuggestion={repoAutocomplete.applySuggestion}
        resetSuggestions={repoAutocomplete.resetSuggestions}
        handleFocus={repoAutocomplete.handleFocus}
        bind:inputEl={repoAutocomplete.inputEl}
        bind:fieldEl={repoAutocomplete.fieldEl}
        submitOnEmptyEnter
        suggestionsPending={repoAutocomplete.suggestionsPending}
      />
      <div class="flex flex-col gap-2">
        <label class="font-semibold text-sm" for="limit"
          >Top contributors per year</label
        >
        <input
          id="limit"
          name="limit"
          type="number"
          bind:value={limit}
          min="1"
          max="50"
          step="1"
          required
          class="w-full rounded-xl border border-slate-300 px-3.5 py-2.5 text-base shadow-sm transition focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200"
        />
      </div>
      <div class="flex items-center">
        <label
          class="flex items-center gap-2 font-semibold text-sm"
          for="exclude-bots"
        >
          <input
            id="exclude-bots"
            name="exclude-bots"
            type="checkbox"
            class="h-4 w-4 rounded border-slate-300 text-blue-500 focus:ring-blue-200"
            bind:checked={excludeBots}
            onchange={() => setHighlight(null)}
          />
          <span>Hide bot accounts</span>
        </label>
      </div>
      <p class="storage-info">
        {#if storageStatus === "ready" && storageInfo}
          <span class="storage-info__line">
            {formatBytes(storageInfo.gitBytes)} of {formatBytes(
              storageInfo.totalBytes,
            )} used
            <span class="storage-info__available"
              >(available {formatBytes(
                storageInfo.availableBytes ??
                  Math.max(storageInfo.totalBytes - storageInfo.usedBytes, 0),
              )})</span
            >
          </span>
        {:else if storageStatus === "loading"}
          <span>Checking storage…</span>
        {:else if storageStatus === "error" && storageError}
          <span class="storage-info__error">{storageError}</span>
        {:else}
          <span>Storage info unavailable</span>
        {/if}
      </p>
      {#if batchStatus}
        <p class="batch-status" aria-live="polite">
          Handling <code>{batchStatus.slug}</code>
          {batchStatus.current}/{batchStatus.total}
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
      <div
        class="progress"
        in:fade={{ duration: 200 }}
        out:fade={{ duration: 200 }}
      >
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
        class:free-scroll={!snapEnabled}
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
        role="application"
        aria-label="Chart strip"
      >
        {#each filteredSummaries as item, index}
          <article
            class="chart-card"
            class:active={index === selectedIndex}
            use:chartRef={index}
          >
            <header class="chart-card__header">
              <span class="chart-card__index"
                >{index + 1}/{filteredSummaries.length}</span
              >
              <span class="chart-card__slug">{item.slug}</span>
              {#if descriptions[index]}
                <span class="chart-card__description"
                  >{descriptions[index]}</span
                >
              {/if}
            </header>
            <ContributionChart
              loading={false}
              series={item.series}
              periods={item.periods}
              interval={item.interval}
              highlighted={index === selectedIndex
                ? highlightedContributor
                : null}
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
    <p class="chart-hint">
      Swipe horizontally or use trackpad scroll to pan between charts.
    </p>
  {/if}

  {#if filteredSummaries.length > 0}
    <div class="thumbnail-strip" aria-label="Chart thumbnails">
      {#each filteredSummaries as summary, index}
        <button
          type="button"
          class="thumbnail"
          class:active={index === selectedIndex}
          onclick={() => {
            cancelSnapRestore();
            stopScrollAnimation();
            snapEnabled = false;
            selectedIndex = index;
            requestAnimationFrame(() => {
              scrollToCard(index).catch(() => {});
            });
          }}
          aria-label={`Show ${summary.slug}`}
        >
          <span class="thumbnail__label">{repositoryName(summary.slug)}</span>
          {#if thumbnailStatus[index] === "ready" && thumbnailUrls[index]}
            <img
              src={thumbnailUrls[index] ?? ""}
              alt={`Preview of ${summary.slug}`}
            />
          {:else if thumbnailStatus[index] === "pending"}
            <span class="thumbnail__placeholder">Rendering…</span>
          {:else}
            <span class="thumbnail__placeholder">Preview unavailable</span>
          {/if}
        </button>
      {/each}
    </div>
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
      {#if activeSummary.periods.length > 0 && activeSummary.periods[0].contributors.length > 0}
        <div class="avatar-grid">
          {#each new Map(activeSummary.series.map( (entry) => [entry.name.toLowerCase(), entry], )).values() as seriesEntry}
            <div class="avatar-card">
              <a
                href={contributorLink(
                  seriesEntry.name,
                  resolvedProfileUrl(
                    seriesEntry.name,
                    (seriesEntry as { profileUrl?: string }).profileUrl,
                  ) ?? undefined,
                )}
                target="_blank"
                rel="noreferrer noopener"
                onmouseenter={() => setHighlight(seriesEntry.name)}
                onmouseleave={() => setHighlight(null)}
                onfocus={() => setHighlight(seriesEntry.name)}
                onblur={() => setHighlight(null)}
              >
                {#if avatarSource(seriesEntry.name, (seriesEntry as { profileUrl?: string }).profileUrl)}
                  <img
                    class="avatar"
                    src={avatarSource(
                      seriesEntry.name,
                      (seriesEntry as { profileUrl?: string }).profileUrl,
                    ) ?? ""}
                    alt={`Avatar of ${seriesEntry.name}`}
                    referrerpolicy="no-referrer"
                  />
                {:else}
                  <span class="avatar avatar--fallback" aria-hidden="true"
                    >{seriesEntry.name.at(0)}</span
                  >
                {/if}
                <span class="avatar-name">{seriesEntry.name}</span>
              </a>
            </div>
          {/each}
        </div>
      {/if}
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
                          class:active={highlightedContributor &&
                            highlightedContributor.toLowerCase() ===
                              contributor.author.toLowerCase()}
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

  .storage-info {
    margin-top: 0.25rem;
    font-size: 0.85rem;
    color: #475569;
  }

  .storage-info__error {
    color: #b91c1c;
  }

  .storage-info__line {
    display: inline-flex;
    gap: 0.35rem;
    align-items: baseline;
  }

  .storage-info__available {
    color: #2563eb;
    font-weight: 600;
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
    cursor: grab;
  }

  .chart-strip.free-scroll {
    scroll-snap-type: none;
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

  .thumbnail-strip {
    margin: 1rem 0 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
  }

  .thumbnail {
    position: relative;
    width: 9.5rem;
    height: 6rem;
    border: none;
    border-radius: 0.75rem;
    padding: 0;
    overflow: hidden;
    background: #f8fafc;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition:
      transform 0.15s ease,
      box-shadow 0.15s ease,
      border 0.15s ease;
    border: 2px solid transparent;
  }

  .thumbnail:hover:not(:disabled) {
    transform: translateY(-2px);
    box-shadow: 0 10px 20px rgba(15, 23, 42, 0.18);
  }

  .thumbnail.active {
    border-color: #2563eb;
    box-shadow: 0 10px 24px rgba(37, 99, 235, 0.25);
  }

  .thumbnail img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
    background: #f8fafc;
  }

  .thumbnail__label {
    position: absolute;
    top: 0.3rem;
    left: 0.4rem;
    right: 0.4rem;
    font-size: 0.72rem;
    font-weight: 600;
    color: #0f172a;
    background: rgba(255, 255, 255, 0.85);
    border-radius: 999px;
    padding: 0.2rem 0.5rem;
    text-align: center;
    pointer-events: none;
    backdrop-filter: blur(2px);
  }

  .thumbnail__placeholder {
    font-size: 0.75rem;
    color: #475569;
    text-align: center;
    padding: 0 0.5rem;
    margin-top: 1.5rem;
    background: rgba(248, 250, 252, 0.9);
    border-radius: 0.5rem;
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
    transition:
      background 0.2s ease,
      color 0.2s ease;
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

  .avatar-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
  }

  .avatar-card a {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.35rem;
    text-decoration: none;
    color: #1f2937;
    font-size: 0.85rem;
  }

  .avatar {
    width: 3rem;
    height: 3rem;
    border-radius: 999px;
    object-fit: cover;
    border: 2px solid rgba(37, 99, 235, 0.15);
    background: #e2e8f0;
  }

  .avatar-name {
    max-width: 6rem;
    text-align: center;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .avatar--fallback {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    color: #1e293b;
  }

  .avatar--fallback {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    color: #1e293b;
  }
</style>
