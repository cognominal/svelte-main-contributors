import { homedir } from "node:os";
import { join } from "node:path";
import type { AggregationInterval, RepoContributionSummary } from "$lib/types";
import { createPersistentCache } from "$lib/server/cache";
import type { ContributionSummaryOptions } from "$lib/server/gitStats";

const GITHUB_BASE_URL = "https://github.com";
const STATS_CACHE = createPersistentCache<CachedContributorStats>(
  "github-contributor-stats.json",
  { maxEntries: 200, maxAgeMs: 6 * 60 * 60 * 1000 },
);

interface CachedContributorStats {
  contributors: Array<{
    key: string;
    name: string;
    profileUrl?: string | null;
    weeks: Array<[number, number]>; // [unixSeconds, commits]
  }>;
  fetchedAt: string;
}

function githubRequestHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  return headers;
}

function repoDirectoryForSlug(slug: string): string {
  const [owner, name, ...rest] = slug.split("/");
  if (!owner || !name || rest.length > 0) {
    throw new Error(`Invalid repository slug "${slug}". Expected the form "owner/name".`);
  }
  const safeName = `${owner}---${name}`;
  return join(homedir(), "git", safeName);
}

function formatDateUTC(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function determineInterval(firstCommit: Date, lastCommit: Date): AggregationInterval {
  const ONE_YEAR_MS = 1000 * 60 * 60 * 24 * 365;
  const duration = lastCommit.getTime() - firstCommit.getTime();
  return duration < ONE_YEAR_MS ? "month" : "year";
}

interface PeriodDefinition {
  label: string;
  start: string;
  end: string;
}

function generateYearPeriods(firstCommit: Date, lastCommit: Date): PeriodDefinition[] {
  const periods: PeriodDefinition[] = [];
  for (let year = firstCommit.getUTCFullYear(); year <= lastCommit.getUTCFullYear(); year += 1) {
    periods.push({
      label: `${year}`,
      start: `${year}-01-01`,
      end: `${year}-12-31`,
    });
  }
  return periods;
}

function generateMonthPeriods(firstCommit: Date, lastCommit: Date): PeriodDefinition[] {
  const periods: PeriodDefinition[] = [];
  let cursorYear = firstCommit.getUTCFullYear();
  let cursorMonth = firstCommit.getUTCMonth();
  const endYear = lastCommit.getUTCFullYear();
  const endMonth = lastCommit.getUTCMonth();

  while (cursorYear < endYear || (cursorYear === endYear && cursorMonth <= endMonth)) {
    const startDate = new Date(Date.UTC(cursorYear, cursorMonth, 1));
    const endDate = new Date(Date.UTC(cursorYear, cursorMonth + 1, 0));
    const label = `${startDate.getUTCFullYear()}-${String(startDate.getUTCMonth() + 1).padStart(2, "0")}`;
    periods.push({
      label,
      start: formatDateUTC(startDate),
      end: formatDateUTC(endDate),
    });
    cursorMonth += 1;
    if (cursorMonth === 12) {
      cursorMonth = 0;
      cursorYear += 1;
    }
  }

  return periods;
}

function periodLabelForDate(date: Date, interval: AggregationInterval): string {
  if (interval === "year") {
    return `${date.getUTCFullYear()}`;
  }
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }
  const abortError = new Error("The operation was aborted.");
  abortError.name = "AbortError";
  throw abortError;
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" }));
    };
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timeout);
        reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" }));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

async function fetchContributorStatsFromGitHub(
  slug: string,
  signal?: AbortSignal,
  onProgress?: ContributionSummaryOptions["onProgress"],
): Promise<CachedContributorStats> {
  const url = `https://api.github.com/repos/${slug}/stats/contributors`;
  const headers = githubRequestHeaders();
  const maxAttempts = 6;
  let attempt = 0;

  while (true) {
    throwIfAborted(signal);
    const response = await fetch(url, { headers, signal });
    if (response.status === 202) {
      attempt += 1;
      if (attempt >= maxAttempts) {
        throw new Error(
          "GitHub is still generating contributor statistics. Please retry in a moment.",
        );
      }
      onProgress?.({
        type: "status",
        message: `GitHub is preparing contributor statistics (attempt ${attempt + 1}/${maxAttempts}).`,
      });
      await delay(500 * 2 ** attempt, signal);
      continue;
    }

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(
        `Unable to fetch contributor statistics for ${slug}: ${response.status} ${detail}`,
      );
    }

    const payload = (await response.json()) as Array<{
      total: number;
      author: {
        login?: string | null;
        html_url?: string | null;
      } | null;
      weeks: Array<{ w: number; c: number }>;
    }> | null;

    const sanitized: CachedContributorStats = {
      fetchedAt: new Date().toISOString(),
      contributors:
        payload?.map((entry, index) => {
          const login = entry?.author?.login ?? null;
          const profileUrl = entry?.author?.html_url ?? (login ? `${GITHUB_BASE_URL}/${login}` : null);
          const name = login ?? `Contributor ${index + 1}`;
          return {
            key: login?.toLowerCase() ?? `anon-${index}`,
            name,
            profileUrl,
            weeks: (entry?.weeks ?? [])
              .filter((week) => typeof week?.w === "number" && typeof week?.c === "number")
              .map((week) => [week.w, week.c] as [number, number]),
          };
        }) ?? [],
    };

    return sanitized;
  }
}

async function loadContributorStats(
  slug: string,
  options?: ContributionSummaryOptions,
): Promise<CachedContributorStats> {
  const cached = await STATS_CACHE.get(slug).catch(() => undefined);
  if (cached?.value) {
    return cached.value;
  }

  const fresh = await fetchContributorStatsFromGitHub(slug, options?.signal, options?.onProgress);
  await STATS_CACHE.set(slug, fresh).catch(() => {});
  return fresh;
}

interface ContributorAggregate {
  key: string;
  name: string;
  profileUrl?: string;
  periodTotals: Map<string, number>;
  total: number;
}

export async function collectRemoteContributionSummary(
  slug: string,
  limit: number,
  options?: ContributionSummaryOptions,
): Promise<RepoContributionSummary | null> {
  if (limit <= 0) {
    throw new Error("The number of contributors to display must be greater than 0.");
  }

  options?.onProgress?.({
    type: "status",
    message: `Fetching GitHub API contributor statistics for ${slug}...`,
  });

  const stats = await loadContributorStats(slug, options);
  const contributors = stats.contributors;
  if (contributors.length === 0) {
    return null;
  }

  let firstWeek: Date | null = null;
  let lastWeek: Date | null = null;

  const contributorWeeks = new Map<
    string,
    { name: string; profileUrl?: string | null; weeks: Array<{ date: Date; commits: number }> }
  >();

  for (const contributor of contributors) {
    const weeks: Array<{ date: Date; commits: number }> = [];
    for (const [weekSeconds, commits] of contributor.weeks) {
      if (!commits || commits <= 0) {
        continue;
      }
      const weekDate = new Date(weekSeconds * 1000);
      weeks.push({ date: weekDate, commits });
      if (!firstWeek || weekDate < firstWeek) {
        firstWeek = weekDate;
      }
      if (!lastWeek || weekDate > lastWeek) {
        lastWeek = weekDate;
      }
    }
    if (weeks.length === 0) {
      continue;
    }
    contributorWeeks.set(contributor.key, {
      name: contributor.name,
      profileUrl: contributor.profileUrl,
      weeks,
    });
  }

  if (!firstWeek || !lastWeek || contributorWeeks.size === 0) {
    return null;
  }

  const firstCommit = new Date(
    Date.UTC(firstWeek.getUTCFullYear(), firstWeek.getUTCMonth(), firstWeek.getUTCDate()),
  );
  const lastCommit = new Date(
    Date.UTC(lastWeek.getUTCFullYear(), lastWeek.getUTCMonth(), lastWeek.getUTCDate()),
  );

  const interval = determineInterval(firstCommit, lastCommit);
  const periodDefinitions =
    interval === "year"
      ? generateYearPeriods(firstCommit, lastCommit)
      : generateMonthPeriods(firstCommit, lastCommit);

  const aggregates = new Map<string, ContributorAggregate>();

  for (const [key, contributor] of contributorWeeks.entries()) {
    const perPeriod = new Map<string, number>();
    let total = 0;
    for (const entry of contributor.weeks) {
      const label = periodLabelForDate(entry.date, interval);
      perPeriod.set(label, (perPeriod.get(label) ?? 0) + entry.commits);
      total += entry.commits;
    }
    if (total === 0) {
      continue;
    }
    aggregates.set(key, {
      key,
      name: contributor.name,
      profileUrl: contributor.profileUrl ?? undefined,
      periodTotals: perPeriod,
      total,
    });
  }

  if (aggregates.size === 0) {
    return null;
  }

  const selectedContributors = new Set<string>();
  const periods = periodDefinitions.map((period) => {
    const ranked: Array<{ key: string; author: string; commits: number; profileUrl?: string }> =
      [];
    for (const aggregate of aggregates.values()) {
      const commits = aggregate.periodTotals.get(period.label) ?? 0;
      if (commits > 0) {
        ranked.push({
          key: aggregate.key,
          author: aggregate.name,
          commits,
          profileUrl: aggregate.profileUrl,
        });
      }
    }
    ranked.sort((a, b) => b.commits - a.commits);
    const top = ranked.slice(0, limit);
    for (const contributor of top) {
      selectedContributors.add(contributor.key);
    }
    return {
      ...period,
      contributors: top.map(({ author, commits, profileUrl }) => ({
        author,
        commits,
        profileUrl,
      })),
    };
  });

  if (selectedContributors.size === 0) {
    return null;
  }

  const series = Array.from(selectedContributors)
    .map((key) => {
      const aggregate = aggregates.get(key);
      if (!aggregate) {
        return null;
      }
      let total = 0;
      const values = periodDefinitions.map((period) => {
        const commits = aggregate.periodTotals.get(period.label) ?? 0;
        total += commits;
        return { label: period.label, commits };
      });
      return {
        name: aggregate.name,
        total,
        values,
        profileUrl: aggregate.profileUrl,
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .sort((a, b) => b.total - a.total);

  options?.onProgress?.({
    type: "status",
    message: `GitHub API contributor statistics ready for ${slug}.`,
  });

  return {
    slug,
    repoPath: repoDirectoryForSlug(slug),
    interval,
    startDate: firstCommit.toISOString(),
    endDate: new Date(lastCommit.getTime() + 6 * 24 * 60 * 60 * 1000).toISOString(),
    periods,
    series,
  };
}
