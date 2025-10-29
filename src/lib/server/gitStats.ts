import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { createPersistentCache } from '$lib/server/cache';
import type {
	AggregationInterval,
	ContributorSeries,
	PeriodContributor,
	RepoContributionSummary
} from '$lib/types';

interface RunOptions {
	cwd: string;
	allowFailure?: boolean;
	onStdout?: (chunk: string) => void;
	onStderr?: (chunk: string) => void;
	signal?: AbortSignal;
}

interface ContributorIdentity {
	name: string;
	email?: string;
	profileUrl?: string;
}

interface PeriodDefinition {
	label: string;
	start: string;
	end: string;
}

export type ProgressEvent =
	| { type: 'status'; message: string }
	| { type: 'git'; command: string; stream: 'stdout' | 'stderr'; text: string };

type ProgressCallback = (event: ProgressEvent) => void;

export interface ContributionSummaryOptions {
	onProgress?: ProgressCallback;
	signal?: AbortSignal;
}

const ONE_YEAR_MS = 1000 * 60 * 60 * 24 * 365;

const GITHUB_BASE_URL = 'https://github.com';
const GITHUB_API_VERSION = '2022-11-28';

const githubProfileCache = new Map<string, string | null>();
const githubNameCache = new Map<string, string | null>();
const githubProfileStore = createPersistentCache<string | null>('github-profiles-by-email.json');
const githubNameStore = createPersistentCache<string | null>('github-profiles-by-name.json');
const summaryStore = createPersistentCache<{
	slug: string;
	limit: number;
	summary: Omit<RepoContributionSummary, 'repoPath'>;
}>('contribution-summaries.json', { maxEntries: 50, maxAgeMs: 1000 * 60 * 60 * 24 });

async function hydrateEmailProfileCache(normalizedEmail: string | null): Promise<void> {
	if (!normalizedEmail || githubProfileCache.has(normalizedEmail)) {
		return;
	}
	const record = await githubProfileStore.get(normalizedEmail);
	if (record) {
		githubProfileCache.set(normalizedEmail, record.value);
	}
}

async function hydrateNameProfileCache(normalizedName: string | null): Promise<void> {
	if (!normalizedName || githubNameCache.has(normalizedName)) {
		return;
	}
	const record = await githubNameStore.get(normalizedName);
	if (record) {
		githubNameCache.set(normalizedName, record.value);
	}
}

async function rememberEmailProfile(normalizedEmail: string, profileUrl: string | null): Promise<void> {
	githubProfileCache.set(normalizedEmail, profileUrl);
	await githubProfileStore.set(normalizedEmail, profileUrl);
}

async function rememberNameProfile(normalizedName: string, profileUrl: string | null): Promise<void> {
	githubNameCache.set(normalizedName, profileUrl);
	await githubNameStore.set(normalizedName, profileUrl);
}

function normalizeEmail(email?: string | null): string | null {
	if (!email) {
		return null;
	}
	return email.trim().toLowerCase() || null;
}

function normalizeName(name?: string | null): string | null {
	if (!name) {
		return null;
	}
	const stripped = name
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^a-zA-Z0-9]/g, '')
		.toLowerCase()
		.trim();
	return stripped || null;
}

function githubRequestHeaders(): Record<string, string> {
	const headers: Record<string, string> = {
		Accept: 'application/vnd.github+json',
		'X-GitHub-Api-Version': GITHUB_API_VERSION
	};

	if (process.env.GITHUB_TOKEN) {
		headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
	}

	return headers;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) {
		return;
	}
	const abortError = new Error('The operation was aborted.');
	abortError.name = 'AbortError';
	throw abortError;
}

function parseSlug(slug: string): { owner: string; name: string } {
	const [owner, name, ...rest] = slug.split('/');
	if (!owner || !name || rest.length > 0) {
		throw new Error(`Invalid repository slug "${slug}". Expected the form "owner/name".`);
	}

	return { owner, name };
}

function repoDirectoryForSlug(slug: string): string {
	const { owner, name } = parseSlug(slug);
	const safeName = `${owner}---${name}`;
	return join(homedir(), 'git', safeName);
}

function summaryCacheKey(slug: string, limit: number): string {
	return `${slug.toLowerCase()}::${limit}`;
}

function sanitizeSummary(summary: RepoContributionSummary): Omit<RepoContributionSummary, 'repoPath'> {
	const { repoPath: _repoPath, periods, series, ...rest } = summary;
	return {
		...rest,
		periods: periods.map((period) => ({
			label: period.label,
			start: period.start,
			end: period.end,
			contributors: period.contributors.map((contributor) => ({ ...contributor }))
		})),
		series: series.map((item) => ({
			name: item.name,
			total: item.total,
			profileUrl: item.profileUrl,
			values: item.values.map((value) => ({ ...value }))
		}))
	};
}

export async function getCachedContributionSummary(
	slug: string,
	limit: number
): Promise<RepoContributionSummary | null> {
	const cacheKey = summaryCacheKey(slug, limit);
	const cachedSummaryEntry = await summaryStore.get(cacheKey).catch(() => undefined);
	const cachedValue = cachedSummaryEntry?.value;
	if (!cachedValue || cachedValue.slug !== slug || cachedValue.limit !== limit) {
		return null;
	}

	const cachedSummary = cachedValue.summary;
	const clonedPeriods = cachedSummary.periods.map((period) => ({
		label: period.label,
		start: period.start,
		end: period.end,
		contributors: period.contributors.map((contributor) => ({ ...contributor }))
	}));
	const clonedSeries = cachedSummary.series.map((series) => ({
		name: series.name,
		total: series.total,
		profileUrl: series.profileUrl,
		values: series.values.map((value) => ({ ...value }))
	}));

	return {
		...cachedSummary,
		repoPath: repoDirectoryForSlug(slug),
		periods: clonedPeriods,
		series: clonedSeries
	};
}

async function runCommand(command: string, args: string[], options: RunOptions): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: {
				...process.env,
				GIT_TERMINAL_PROMPT: '0'
			}
		});

		let stdout = '';
		let stderr = '';
		let settled = false;

		const cleanup = () => {
			if (!settled) {
				settled = true;
				try {
					// Try graceful termination first
					child.kill('SIGTERM');
					// Immediately follow up with SIGKILL for git processes that ignore SIGTERM
					setTimeout(() => {
						try {
							child.kill('SIGKILL');
						} catch (e) {
							// Process already dead, ignore
						}
					}, 100); // Reduced from 1000ms to 100ms for faster cleanup
				} catch (e) {
					// Process might already be dead
				}
			}
		};

		// Handle abort signal
		const abortHandler = () => {
			console.log(`[ABORT] Abort signal received, killing child process PID ${child.pid}`);
			cleanup();
			if (!settled) {
				settled = true;
				const abortError = new Error('The operation was aborted.');
				abortError.name = 'AbortError';
				reject(abortError);
			}
		};

		if (options.signal) {
			if (options.signal.aborted) {
				console.log(`[ABORT] Signal already aborted before starting command`);
				abortHandler();
				return;
			}
			options.signal.addEventListener('abort', abortHandler, { once: true });
			console.log(`[ABORT] Abort listener registered for command: ${command} ${args.join(' ')}`);
		}

		child.stdout?.setEncoding('utf-8');
		child.stderr?.setEncoding('utf-8');

		child.stdout?.on('data', (chunk) => {
			stdout += chunk;
			options.onStdout?.(chunk);
		});

		child.stderr?.on('data', (chunk) => {
			stderr += chunk;
			options.onStderr?.(chunk);
		});

		child.on('error', (error) => {
			settled = true;
			if (options.signal) {
				options.signal.removeEventListener('abort', abortHandler);
			}
			reject(error);
		});

		child.on('close', (code) => {
			settled = true;
			if (options.signal) {
				options.signal.removeEventListener('abort', abortHandler);
			}

			if (code === 0) {
				resolve(stdout.trim());
				return;
			}

			if (options.allowFailure) {
				resolve(stdout.trim());
				return;
			}

			const argsString = [command, ...args].join(' ');
			reject(new Error(`Command failed (${code ?? 'unknown'}): ${argsString}\n${stderr.trim()}`));
		});
	});
}

function createGitProgressHandlers(commandLabel: string, onProgress?: ProgressCallback): Pick<RunOptions, 'onStdout' | 'onStderr'> {
	if (!onProgress) {
		return {};
	}

	return {
		onStdout: (chunk: string) => {
			onProgress({ type: 'git', command: commandLabel, stream: 'stdout', text: chunk });
		},
		onStderr: (chunk: string) => {
			onProgress({ type: 'git', command: commandLabel, stream: 'stderr', text: chunk });
		}
	};
}

async function ensureFullClone(
	repoPath: string,
	onProgress?: ProgressCallback,
	signal?: AbortSignal
): Promise<void> {
	throwIfAborted(signal);

	// Skip network operations for now - just work with what we have locally
	onProgress?.({ type: 'status', message: 'Using local repository data (skipping fetch)...' });
	return;

	const fetchArgs = ['fetch', '--progress', '--all', '--tags'];
	onProgress?.({ type: 'status', message: 'Fetching remote references (timeout in 15s)...' });

	let lastCountdown = -1;
	const fetchProgressCallback = (remaining: number) => {
		if (remaining !== lastCountdown) {
			lastCountdown = remaining;
			onProgress?.({
				type: 'status',
				message: `Fetching remote references (timeout in ${remaining}s)...`
			});
		}
	};

	// Create a timeout-specific abort controller linked to parent signal
	const fetchController = new AbortController();
	if (signal) {
		if (signal.aborted) {
			fetchController.abort();
		} else {
			signal.addEventListener('abort', () => fetchController.abort(), { once: true });
		}
	}

	const fetchResult = await withTimeoutAndAbort({
		promise: runCommand('git', fetchArgs, {
			cwd: repoPath,
			...createGitProgressHandlers('git fetch --all --tags', onProgress),
			signal: fetchController.signal
		}),
		timeoutMs: 5000, // Reduced to 5 seconds for faster debugging
		defaultValue: 'TIMEOUT' as const,
		controller: fetchController,
		onProgress: fetchProgressCallback
	});

	if (fetchResult === 'TIMEOUT') {
		onProgress?.({
			type: 'status',
			message: 'Fetch operation timed out - continuing with existing refs...'
		});
	}

	throwIfAborted(signal);
	const isShallow = await runCommand('git', ['rev-parse', '--is-shallow-repository'], { cwd: repoPath, signal });
	if (isShallow === 'true') {
		onProgress?.({ type: 'status', message: 'Expanding shallow clone (timeout in 15s)...' });

		lastCountdown = -1;
		const unshallowProgressCallback = (remaining: number) => {
			if (remaining !== lastCountdown) {
				lastCountdown = remaining;
				onProgress?.({
					type: 'status',
					message: `Expanding shallow clone (timeout in ${remaining}s)...`
				});
			}
		};

		// Create a timeout-specific abort controller linked to parent signal
		const unshallowController = new AbortController();
		if (signal) {
			if (signal.aborted) {
				unshallowController.abort();
			} else {
				signal.addEventListener('abort', () => unshallowController.abort(), { once: true });
			}
		}

		const unshallowResult = await withTimeoutAndAbort({
			promise: runCommand('git', ['fetch', '--progress', '--unshallow'], {
				cwd: repoPath,
				...createGitProgressHandlers('git fetch --unshallow', onProgress),
				signal: unshallowController.signal
			}),
			timeoutMs: 15000,
			defaultValue: 'TIMEOUT' as const,
			controller: unshallowController,
			onProgress: unshallowProgressCallback
		});

		if (unshallowResult === 'TIMEOUT') {
			onProgress?.({
				type: 'status',
				message: 'Unshallow operation timed out - continuing with shallow clone...'
			});
		}
	}
}

async function initialiseRepository(slug: string, options?: ContributionSummaryOptions): Promise<string> {
	console.log(`[INIT] Starting initialiseRepository for ${slug}`);
	throwIfAborted(options?.signal);
	const repoPath = repoDirectoryForSlug(slug);
	console.log(`[INIT] Repo path: ${repoPath}`);
	const baseDir = join(homedir(), 'git');
	await mkdir(baseDir, { recursive: true });

	if (!existsSync(repoPath)) {
		console.log(`[INIT] Repo doesn't exist, cloning...`);
		const cloneUrl = `${GITHUB_BASE_URL}/${slug}.git`;
		options?.onProgress?.({ type: 'status', message: `Cloning ${slug} (timeout in 15s)...` });

		let lastCountdown = -1;
		const cloneProgressCallback = (remaining: number) => {
			if (remaining !== lastCountdown) {
				lastCountdown = remaining;
				options?.onProgress?.({
					type: 'status',
					message: `Cloning ${slug} (timeout in ${remaining}s)...`
				});
			}
		};

		// Create a timeout-specific abort controller linked to parent signal
		const cloneController = new AbortController();
		if (options?.signal) {
			if (options.signal.aborted) {
				cloneController.abort();
			} else {
				options.signal.addEventListener('abort', () => cloneController.abort(), { once: true });
			}
		}

		const cloneResult = await withTimeoutAndAbort({
			promise: runCommand('git', ['clone', '--progress', '--no-tags', cloneUrl, repoPath], {
				cwd: baseDir,
				...createGitProgressHandlers(`git clone ${slug}`, options?.onProgress),
				signal: cloneController.signal
			}),
			timeoutMs: 15000,
			defaultValue: 'TIMEOUT' as const,
			controller: cloneController,
			onProgress: cloneProgressCallback
		});

		if (cloneResult === 'TIMEOUT') {
			throw new Error(`Clone operation timed out after 15 seconds. Repository ${slug} may be too large. Try a smaller repository.`);
		}

		options?.onProgress?.({ type: 'status', message: 'Clone complete.' });
	} else {
		console.log(`[INIT] Repo exists at ${repoPath}`);
	}

	console.log(`[INIT] About to call ensureFullClone`);
	throwIfAborted(options?.signal);
	await ensureFullClone(repoPath, options?.onProgress, options?.signal);
	console.log(`[INIT] ensureFullClone returned`);

	// Skip git pull for now - just use local data
	options?.onProgress?.({ type: 'status', message: 'Repository ready (using local data).' });
	console.log(`[INIT] Returning repo path: ${repoPath}`);

	return repoPath;
}

async function resolveCommitWindow(
	repoPath: string,
	signal?: AbortSignal
): Promise<{ firstCommit: Date; lastCommit: Date }> {
	throwIfAborted(signal);
	const latestCommitOutput = await runCommand(
		'git',
		['log', '--format=%ad', '--date=iso-strict', '--max-count=1'],
		{ cwd: repoPath, signal }
	);

	if (!latestCommitOutput) {
		throw new Error('No commits found in repository.');
	}

	throwIfAborted(signal);
	// Use git rev-list to find root commits (initial commits) more efficiently
	const rootCommitsOutput = await runCommand(
		'git',
		['rev-list', '--max-parents=0', 'HEAD', '--date-order'],
		{ cwd: repoPath, signal }
	);

	const rootCommitSha = rootCommitsOutput
		.split('\n')
		.map((line) => line.trim())
		.find(Boolean);

	let earliestCommitOutput = latestCommitOutput;
	if (rootCommitSha) {
		const rootCommitDate = await runCommand(
			'git',
			['log', '--format=%ad', '--date=iso-strict', '--max-count=1', rootCommitSha],
			{ cwd: repoPath, signal }
		);
		earliestCommitOutput = rootCommitDate || latestCommitOutput;
	}

	const firstCommit = new Date(earliestCommitOutput);
	const lastCommit = new Date(latestCommitOutput);

	if (Number.isNaN(firstCommit.getTime()) || Number.isNaN(lastCommit.getTime())) {
		throw new Error('Failed to parse commit dates from git history.');
	}

	return { firstCommit, lastCommit };
}

function deriveProfileUrl(email?: string): string | undefined {
	if (!email) {
		return undefined;
	}

	const lowerEmail = email.toLowerCase();

	const noreplyMatch = lowerEmail.match(/^(.+?)@users\.noreply\.github\.com$/);
	if (noreplyMatch) {
		const identifier = noreplyMatch[1];
		const username = identifier.includes('+') ? identifier.split('+').pop() : identifier;
		if (username) {
			return `https://github.com/${username}`;
		}
	}

	const githubMatch = lowerEmail.match(/^(.+?)@github\.com$/);
	if (githubMatch) {
		const username = githubMatch[1];
		if (username) {
			return `https://github.com/${username}`;
		}
	}

	return undefined;
}

function parseContributorIdentity(raw: string): ContributorIdentity {
	const emailMatch = raw.match(/^(.*)<(.+)>$/);
	const name = (emailMatch ? emailMatch[1] : raw).trim();
	const email = emailMatch ? emailMatch[2].trim() : undefined;
	const profileUrl = deriveProfileUrl(email);

	return { name, email, profileUrl };
}

function parseShortlog(output: string, limit: number): PeriodContributor[] {
	return output
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean)
		.slice(0, limit)
		.map((line) => {
			const [countPart, ...nameParts] = line.split('\t');
			if (!countPart || nameParts.length === 0) {
				throw new Error(`Unexpected shortlog row: "${line}"`);
			}

			const commits = Number.parseInt(countPart, 10);
			const identity = parseContributorIdentity(nameParts.join('\t'));

			return {
				author: identity.name,
				commits: Number.isNaN(commits) ? 0 : commits,
				profileUrl: identity.profileUrl,
				email: identity.email
			};
		});
}

async function lookupProfileUrlFromGitHub(
	slug: string,
	repoPath: string,
	email: string,
	name: string | undefined,
	signal?: AbortSignal
): Promise<string | undefined> {
	const normalizedEmail = normalizeEmail(email);
	const normalizedName = normalizeName(name);

	if (!normalizedEmail) {
		if (normalizedName) {
			await hydrateNameProfileCache(normalizedName);
			const cachedByName = githubNameCache.get(normalizedName);
			if (cachedByName !== undefined) {
				return cachedByName ?? undefined;
			}
			return await lookupProfileUrlByName(name!, signal);
		}
		return undefined;
	}

	await hydrateEmailProfileCache(normalizedEmail);
	const cached = githubProfileCache.get(normalizedEmail);
	if (cached !== undefined) {
		return cached ?? undefined;
	}

	const applyNameCache = async (profileUrl: string | undefined) => {
		if (profileUrl && normalizedName) {
			await rememberNameProfile(normalizedName, profileUrl);
		}
	};

	const attemptNameFallback = async () => {
		if (name) {
			const viaName = await lookupProfileUrlByName(name, signal);
			if (viaName) {
				await rememberEmailProfile(normalizedEmail, viaName);
				await applyNameCache(viaName);
				return viaName;
			}
		}
		await rememberEmailProfile(normalizedEmail, null);
		return undefined;
	};

	try {
		const commitOutput = await runCommand(
			'git',
			['log', '--format=%H', '--max-count=1', `--author=${email}`],
			{ cwd: repoPath, signal, allowFailure: true }
		);
		const commitSha = commitOutput
			.split('\n')
			.map((line) => line.trim())
			.find(Boolean);
		if (!commitSha) {
			return await attemptNameFallback();
		}

		const response = await fetch(`https://api.github.com/repos/${slug}/commits/${commitSha}`, {
			headers: githubRequestHeaders(),
			signal
		});

		if (!response.ok) {
			return await attemptNameFallback();
		}

		const payload = (await response.json()) as {
			author?: { login?: string | null; html_url?: string | null };
			commit?: { author?: { name?: string | null }; committer?: { name?: string | null } };
		};
		const login = payload.author?.login ?? undefined;
		const htmlUrl = payload.author?.html_url ?? undefined;
		let profileUrl = htmlUrl ?? (login ? `${GITHUB_BASE_URL}/${login}` : undefined);

		if (!profileUrl) {
			const fallbackName =
				payload.commit?.author?.name ??
				payload.commit?.committer?.name ??
				name;
			if (fallbackName) {
				profileUrl = await lookupProfileUrlByName(fallbackName, signal);
			}
		}

		if (!profileUrl) {
			return await attemptNameFallback();
		}

		await rememberEmailProfile(normalizedEmail, profileUrl);
		await applyNameCache(profileUrl);
		return profileUrl;
	} catch (error) {
		if ((error as Error)?.name === 'AbortError') {
			throw error;
		}
		return await attemptNameFallback();
	}
}

async function fetchProfilesForEmails(
	slug: string,
	repoPath: string,
	lookups: Iterable<[string, { email: string; name: string }]>,
	signal?: AbortSignal
): Promise<Map<string, string>> {
	const resolved = new Map<string, string>();
	for (const [normalizedEmail, { email, name }] of lookups) {
		throwIfAborted(signal);
		const profileUrl = await lookupProfileUrlFromGitHub(slug, repoPath, email, name, signal).catch(() => undefined);
		if (profileUrl) {
			resolved.set(normalizedEmail, profileUrl);
		}
	}
	return resolved;
}

async function lookupProfileUrlByName(name: string, signal?: AbortSignal): Promise<string | undefined> {
	const normalized = normalizeName(name);
	if (!normalized) {
		return undefined;
	}

	await hydrateNameProfileCache(normalized);
	const cached = githubNameCache.get(normalized);
	if (cached !== undefined) {
		return cached ?? undefined;
	}

	try {
		const query = `${name} in:fullname`;
		const response = await fetch(
			`https://api.github.com/search/users?q=${encodeURIComponent(query)}&per_page=5`,
			{
				headers: githubRequestHeaders(),
				signal
			}
		);

		if (!response.ok) {
			await rememberNameProfile(normalized, null);
			return undefined;
		}

		const payload = (await response.json()) as { items?: Array<{ login?: string | null; html_url?: string | null }> };
		const items = payload.items ?? [];

		const evaluateCandidate = async (login: string, htmlUrl?: string | null): Promise<string | undefined> => {
			const loginNormalized = normalizeName(login);
			if (loginNormalized && (loginNormalized === normalized || normalized.includes(loginNormalized))) {
				return htmlUrl ?? `${GITHUB_BASE_URL}/${login}`;
			}

			try {
				const detailResponse = await fetch(`https://api.github.com/users/${login}`, {
					headers: githubRequestHeaders(),
					signal
				});
				if (!detailResponse.ok) {
					return undefined;
				}
				const user = (await detailResponse.json()) as { name?: string | null; html_url?: string | null };
				const candidateName = normalizeName(user.name ?? login);
				if (candidateName && (candidateName === normalized || normalized.includes(candidateName))) {
					return user.html_url ?? `${GITHUB_BASE_URL}/${login}`;
				}
				return undefined;
			} catch (error) {
				if ((error as Error)?.name === 'AbortError') {
					throw error;
				}
				return undefined;
			}
		};

		for (const item of items) {
			if (!item?.login) {
				continue;
			}
			const match = await evaluateCandidate(item.login, item.html_url);
			if (match) {
				await rememberNameProfile(normalized, match);
				return match;
			}
		}

		if (items.length > 0 && items[0]?.login) {
				const fallback = items[0].html_url ?? `${GITHUB_BASE_URL}/${items[0].login}`;
			await rememberNameProfile(normalized, fallback);
			return fallback;
		}

		await rememberNameProfile(normalized, null);
		return undefined;
	} catch (error) {
		if ((error as Error)?.name === 'AbortError') {
			throw error;
		}
		await rememberNameProfile(normalized, null);
		return undefined;
	}
}

function formatDateUTC(date: Date): string {
	const year = date.getUTCFullYear();
	const month = String(date.getUTCMonth() + 1).padStart(2, '0');
	const day = String(date.getUTCDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
}

function generateYearPeriods(firstCommit: Date, lastCommit: Date): PeriodDefinition[] {
	const periods: PeriodDefinition[] = [];
	for (let year = firstCommit.getUTCFullYear(); year <= lastCommit.getUTCFullYear(); year += 1) {
		periods.push({
			label: `${year}`,
			start: `${year}-01-01`,
			end: `${year}-12-31`
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
		const label = `${startDate.getUTCFullYear()}-${String(startDate.getUTCMonth() + 1).padStart(2, '0')}`;
		periods.push({
			label,
			start: formatDateUTC(startDate),
			end: formatDateUTC(endDate)
		});

		cursorMonth += 1;
		if (cursorMonth === 12) {
			cursorMonth = 0;
			cursorYear += 1;
		}
	}

	return periods;
}

function determineInterval(firstCommit: Date, lastCommit: Date): AggregationInterval {
	const duration = lastCommit.getTime() - firstCommit.getTime();
	return duration < ONE_YEAR_MS ? 'month' : 'year';
}

interface TimeoutWithAbortOptions<T> {
	promise: Promise<T>;
	timeoutMs: number;
	defaultValue: T;
	controller: AbortController; // Changed from signal to controller so we can abort it
	onProgress?: (remaining: number) => void;
}

async function withTimeoutAndAbort<T>(options: TimeoutWithAbortOptions<T>): Promise<T> {
	const { promise, timeoutMs, defaultValue, controller, onProgress } = options;
	const startTime = Date.now();
	let timeout: NodeJS.Timeout | undefined;
	let progressTimeout: NodeJS.Timeout | undefined;

	const timeoutPromise = new Promise<T>((resolve) => {
		timeout = setTimeout(() => {
			console.log(`[TIMEOUT] Firing timeout after ${timeoutMs}ms, aborting controller...`);
			// Abort the controller passed from the caller
			controller.abort();
			console.log(`[TIMEOUT] Controller aborted, resolving with default value`);
			resolve(defaultValue);
		}, timeoutMs);
	});

	const progress = () => {
		if (onProgress) {
			const elapsed = Date.now() - startTime;
			if (elapsed < timeoutMs) {
				const remaining = Math.max(0, Math.ceil((timeoutMs - elapsed) / 1000));
				onProgress(remaining);
				progressTimeout = setTimeout(progress, 1000);
			} else {
				onProgress(0);
			}
		}
	};

	if (onProgress) {
		progress();
	}

	return Promise.race([promise, timeoutPromise]).finally(() => {
		if (timeout) clearTimeout(timeout);
		if (progressTimeout) clearTimeout(progressTimeout);
	});
}

async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	defaultValue: T,
	onProgress?: (remaining: number) => void
): Promise<T> {
	// For backward compatibility, create a temporary controller (but this won't actually work for killing processes)
	const tempController = new AbortController();
	return withTimeoutAndAbort({ promise, timeoutMs, defaultValue, controller: tempController, onProgress });
}

async function getCloneDepth(
	repoPath: string,
	signal?: AbortSignal,
	onProgress?: (remaining: number) => void
): Promise<number | null> {
	try {
		const output = await withTimeout(
			runCommand('git', ['rev-list', '--count', '--all'], {
				cwd: repoPath,
				allowFailure: true,
				signal
			}),
			15000,
			'',
			onProgress
		);
		const count = Number.parseInt(output, 10);
		return Number.isNaN(count) ? null : count;
	} catch {
		return null;
	}
}

async function getDiskSize(
	repoPath: string,
	signal?: AbortSignal,
	onProgress?: (remaining: number) => void
): Promise<number | null> {
	try {
		const parentDir = dirname(repoPath);
		const output = await withTimeout(
			runCommand('du', ['-sk', repoPath], {
				cwd: parentDir,
				allowFailure: true,
				signal
			}),
			15000,
			'',
			onProgress
		);
		const match = output.match(/^(\d+)/);
		if (!match) {
			return null;
		}
		// du -sk returns size in kilobytes, convert to bytes
		return Number.parseInt(match[1], 10) * 1024;
	} catch {
		return null;
	}
}

async function getRepoDescription(
	slug: string,
	signal?: AbortSignal,
	onProgress?: (remaining: number) => void
): Promise<string | undefined> {
	try {
		const response = await withTimeout(
			fetch(`https://api.github.com/repos/${slug}`, {
				headers: githubRequestHeaders(),
				signal
			}),
			15000,
			null as any,
			onProgress
		);
		if (!response || !response.ok) {
			return undefined;
		}
		const data = (await response.json()) as { description?: string | null };
		return data.description ?? undefined;
	} catch {
		return undefined;
	}
}

export async function deleteRepositoryClone(slug: string): Promise<void> {
	const repoPath = repoDirectoryForSlug(slug);
	const { rm } = await import('node:fs/promises');
	await rm(repoPath, { recursive: true, force: true });
}

export async function collectContributionSummary(
	slug: string,
	limit: number,
	options?: ContributionSummaryOptions
): Promise<RepoContributionSummary> {
	console.log(`[COLLECT] Starting collectContributionSummary for ${slug}, limit=${limit}`);
	if (limit <= 0) {
		throw new Error('The number of contributors to display must be greater than 0.');
	}

	throwIfAborted(options?.signal);
	console.log(`[COLLECT] About to send progress message for ${slug}`);
	options?.onProgress?.({ type: 'status', message: `Preparing repository data for ${slug}...` });
	console.log(`[COLLECT] Calling initialiseRepository for ${slug}`);
	const repoPath = await initialiseRepository(slug, options);
	console.log(`[COLLECT] initialiseRepository returned: ${repoPath}`);
	throwIfAborted(options?.signal);
	console.log(`[COLLECT] Calling resolveCommitWindow for ${slug}`);
	const { firstCommit, lastCommit } = await resolveCommitWindow(repoPath, options?.signal);
	console.log(`[COLLECT] resolveCommitWindow returned for ${slug}`);
	const firstCommitIso = firstCommit.toISOString();
	const lastCommitIso = lastCommit.toISOString();
	const cacheKey = summaryCacheKey(slug, limit);
	const cachedSummaryEntry = await summaryStore.get(cacheKey).catch(() => undefined);
	const cachedValue = cachedSummaryEntry?.value;
	if (
		cachedValue &&
		cachedValue.slug === slug &&
		cachedValue.limit === limit &&
		cachedValue.summary.startDate === firstCommitIso &&
		cachedValue.summary.endDate === lastCommitIso
	) {
		options?.onProgress?.({
			type: 'status',
			message: 'Using cached contributor summary.'
		});
		return {
			...cachedValue.summary,
			repoPath
		};
	}
	const interval = determineInterval(firstCommit, lastCommit);
	const periodDefinitions =
		interval === 'year'
			? generateYearPeriods(firstCommit, lastCommit)
			: generateMonthPeriods(firstCommit, lastCommit);

	throwIfAborted(options?.signal);
	options?.onProgress?.({
		type: 'status',
		message: `Calculating top ${limit} contributors per ${interval === 'year' ? 'year' : 'month'}`
	});

	const periods: RepoContributionSummary['periods'] = [];
	const contributorMap = new Map<
		string,
		{ commits: Map<string, number>; name: string; profileUrl?: string; emails: Set<string> }
	>();
	const pendingProfileLookups = new Map<
		string,
		{ email: string; name: string; references: Array<{ periodIndex: number; contributorIndex: number }> }
	>();

	const progressStride = Math.max(1, Math.ceil(periodDefinitions.length / 10));
	const canReuseCached = Boolean(cachedValue && cachedValue.summary.interval === interval);
	const cachedPeriodsByLabel = new Map<string, PeriodContributor[]>();
	if (canReuseCached && cachedValue) {
		for (const cachedPeriod of cachedValue.summary.periods) {
			cachedPeriodsByLabel.set(cachedPeriod.label, cachedPeriod.contributors);
		}
	}
	const lastPeriodLabel =
		periodDefinitions.length > 0 ? periodDefinitions[periodDefinitions.length - 1]?.label ?? null : null;

	for (const [index, period] of periodDefinitions.entries()) {
		throwIfAborted(options?.signal);
		let contributors: PeriodContributor[] | undefined;
		let reusedPeriod = false;

		if (canReuseCached && cachedPeriodsByLabel.has(period.label) && period.label !== lastPeriodLabel) {
			const cachedContributors = cachedPeriodsByLabel.get(period.label);
			if (cachedContributors) {
				contributors = cachedContributors.map((entry) => ({ ...entry }));
				reusedPeriod = true;
			}
		}

		if (!contributors) {
			const output = await runCommand(
				'git',
				[
					'shortlog',
					'-s',
					'-n',
					'--all',
					'--no-merges',
					'--email',
					`--since=${period.start}`,
					`--until=${period.end}`
				],
				{ cwd: repoPath, signal: options?.signal }
			);

			contributors = parseShortlog(output, limit);
		}

		const periodRecord = { ...period, contributors };
		periods.push(periodRecord);
		const periodIndex = periods.length - 1;
		if ((index + 1) % progressStride === 0 || index === periodDefinitions.length - 1) {
			options?.onProgress?.({
				type: 'status',
				message: reusedPeriod
					? `Reused cached data for ${index + 1} of ${periodDefinitions.length} periods`
					: `Processed ${index + 1} of ${periodDefinitions.length} periods`
			});
		}

		for (const [contributorIndex, contributor] of contributors.entries()) {
			const { author, commits, profileUrl, email } = contributor;
			const normalizedEmail = normalizeEmail(email);
			if (!profileUrl && normalizedEmail) {
				const existingLookup = pendingProfileLookups.get(normalizedEmail);
				if (existingLookup) {
					existingLookup.references.push({ periodIndex, contributorIndex });
				} else {
					pendingProfileLookups.set(normalizedEmail, {
						email: email!,
						name: author,
						references: [{ periodIndex, contributorIndex }]
					});
				}
			}

			const contributorKey = profileUrl ?? author.toLowerCase();
			const existing = contributorMap.get(contributorKey);
			if (existing) {
				existing.commits.set(period.label, commits);
				if (!existing.profileUrl && profileUrl) {
					existing.profileUrl = profileUrl;
				}
				if (normalizedEmail) {
					existing.emails.add(normalizedEmail);
				}
				continue;
			}

			const perPeriod = new Map<string, number>();
			perPeriod.set(period.label, commits);
			const emails = normalizedEmail ? new Set<string>([normalizedEmail]) : new Set<string>();
			contributorMap.set(contributorKey, { commits: perPeriod, name: author, profileUrl, emails });
		}
	}

	console.log(`[COLLECT] Profile lookups needed: ${pendingProfileLookups.size} for ${slug}`);

	// DISABLED: This profile lookup makes hundreds of sequential GitHub API calls
	// which causes hangs and rate limiting. Skip it entirely for now.
	// TODO: Implement batched/parallel profile lookups with rate limiting
	if (false && pendingProfileLookups.size > 0) {
		console.log(`[COLLECT] Starting fetchProfilesForEmails for ${slug}`);
		const resolvedProfiles = await fetchProfilesForEmails(
			slug,
			repoPath,
			pendingProfileLookups,
			options?.signal
		);
		console.log(`[COLLECT] fetchProfilesForEmails completed for ${slug}`);

		for (const [normalizedEmail, profileUrl] of resolvedProfiles) {
			const lookup = pendingProfileLookups.get(normalizedEmail);
			if (!lookup) {
				continue;
			}

			for (const { periodIndex, contributorIndex } of lookup.references) {
				const periodEntry = periods[periodIndex];
				const contributor = periodEntry?.contributors?.[contributorIndex];
				if (contributor && !contributor.profileUrl) {
					contributor.profileUrl = profileUrl;
				}
			}

			for (const entry of contributorMap.values()) {
				if (!entry.profileUrl && entry.emails.has(normalizedEmail)) {
					entry.profileUrl = profileUrl;
				}
			}
		}
	}
	console.log(`[COLLECT] Skipped profile lookups, continuing with summary generation for ${slug}`);

	const series: ContributorSeries[] = Array.from(contributorMap.values())
		.map((entry) => {
			const { name, commits: periodMap, profileUrl } = entry;
			const values = [];
			let total = 0;
			for (const period of periodDefinitions) {
				const commits = periodMap.get(period.label) ?? 0;
				total += commits;
				values.push({ label: period.label, commits });
			}

			return { name, total, values, profileUrl };
		})
		.sort((a, b) => b.total - a.total);

	options?.onProgress?.({ type: 'status', message: 'Contributor statistics ready.' });

	// Gather repository metadata
	throwIfAborted(options?.signal);
	options?.onProgress?.({ type: 'status', message: 'Gathering repository metadata...' });

	let lastCountdown = -1;
	const progressCallback = (remaining: number) => {
		if (remaining !== lastCountdown) {
			lastCountdown = remaining;
			options?.onProgress?.({
				type: 'status',
				message: `Gathering repository metadata (timeout in ${remaining}s)...`
			});
		}
	};

	const [description, cloneDepth, diskSize] = await Promise.all([
		getRepoDescription(slug, options?.signal, progressCallback),
		getCloneDepth(repoPath, options?.signal, progressCallback),
		getDiskSize(repoPath, options?.signal, progressCallback)
	]);

	const finalSummary: RepoContributionSummary = {
		slug,
		repoPath,
		description,
		cloneDepth,
		diskSize,
		interval,
		startDate: firstCommitIso,
		endDate: lastCommitIso,
		periods,
		series
	};

	await summaryStore
		.set(cacheKey, { slug, limit, summary: sanitizeSummary(finalSummary) })
		.catch(() => {
			// ignore cache persistence failures
		});

	return finalSummary;
}
