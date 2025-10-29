import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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

async function runCommand(command: string, args: string[], options: RunOptions): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: {
				...process.env,
				GIT_TERMINAL_PROMPT: '0'
			},
			signal: options.signal
		});

		let stdout = '';
		let stderr = '';

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
			reject(error);
		});

		child.on('close', (code) => {
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
	const fetchArgs = ['fetch', '--progress', '--all', '--tags'];
	onProgress?.({ type: 'status', message: 'Fetching remote references...' });
	await runCommand('git', fetchArgs, {
		cwd: repoPath,
		...createGitProgressHandlers('git fetch --all --tags', onProgress),
		signal
	});

	throwIfAborted(signal);
	const isShallow = await runCommand('git', ['rev-parse', '--is-shallow-repository'], { cwd: repoPath, signal });
	if (isShallow === 'true') {
		onProgress?.({ type: 'status', message: 'Expanding shallow clone...' });
		await runCommand('git', ['fetch', '--progress', '--unshallow'], {
			cwd: repoPath,
			...createGitProgressHandlers('git fetch --unshallow', onProgress),
			signal
		});
	}
}

async function initialiseRepository(slug: string, options?: ContributionSummaryOptions): Promise<string> {
	throwIfAborted(options?.signal);
	const repoPath = repoDirectoryForSlug(slug);
	const baseDir = join(homedir(), 'git');
	await mkdir(baseDir, { recursive: true });

	if (!existsSync(repoPath)) {
		const cloneUrl = `${GITHUB_BASE_URL}/${slug}.git`;
		options?.onProgress?.({ type: 'status', message: `Cloning ${slug} for the first time...` });
		await runCommand('git', ['clone', '--progress', '--no-tags', cloneUrl, repoPath], {
			cwd: baseDir,
			...createGitProgressHandlers(`git clone ${slug}`, options?.onProgress),
			signal: options?.signal
		});
		options?.onProgress?.({ type: 'status', message: 'Clone complete.' });
	}

	throwIfAborted(options?.signal);
	await ensureFullClone(repoPath, options?.onProgress, options?.signal);
	options?.onProgress?.({ type: 'status', message: 'Fast-forwarding to latest default branch...' });
	await runCommand('git', ['pull', '--progress', '--ff-only'], {
		cwd: repoPath,
		allowFailure: true,
		...createGitProgressHandlers('git pull --ff-only', options?.onProgress),
		signal: options?.signal
	});
	options?.onProgress?.({ type: 'status', message: 'Repository up to date.' });

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
	const chronologicalOutput = await runCommand(
		'git',
		['log', '--format=%ad', '--date=iso-strict', '--reverse'],
		{ cwd: repoPath, signal }
	);

	const earliestCommitOutput =
		chronologicalOutput
			.split('\n')
			.map((line) => line.trim())
			.find(Boolean) ?? latestCommitOutput;

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

export async function collectContributionSummary(
	slug: string,
	limit: number,
	options?: ContributionSummaryOptions
): Promise<RepoContributionSummary> {
	if (limit <= 0) {
		throw new Error('The number of contributors to display must be greater than 0.');
	}

	throwIfAborted(options?.signal);
	options?.onProgress?.({ type: 'status', message: `Preparing repository data for ${slug}...` });
	const repoPath = await initialiseRepository(slug, options);
	throwIfAborted(options?.signal);
	const { firstCommit, lastCommit } = await resolveCommitWindow(repoPath, options?.signal);
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

	for (const [index, period] of periodDefinitions.entries()) {
		throwIfAborted(options?.signal);
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

		const contributors = parseShortlog(output, limit);
		const periodRecord = { ...period, contributors };
		periods.push(periodRecord);
		const periodIndex = periods.length - 1;
		if ((index + 1) % progressStride === 0 || index === periodDefinitions.length - 1) {
			options?.onProgress?.({
				type: 'status',
				message: `Processed ${index + 1} of ${periodDefinitions.length} periods`
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

	if (pendingProfileLookups.size > 0) {
		const resolvedProfiles = await fetchProfilesForEmails(
			slug,
			repoPath,
			pendingProfileLookups,
			options?.signal
		);

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

	return {
		slug,
		repoPath,
		interval,
		startDate: firstCommit.toISOString(),
		endDate: lastCommit.toISOString(),
		periods,
		series
	};
}
