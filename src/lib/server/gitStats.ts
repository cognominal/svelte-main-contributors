import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
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
	const fetchArgs = ['fetch', '--all', '--tags'];
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
		await runCommand('git', ['fetch', '--unshallow'], {
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
		await runCommand('git', ['clone', '--no-tags', cloneUrl, repoPath], {
			cwd: baseDir,
			...createGitProgressHandlers(`git clone ${slug}`, options?.onProgress),
			signal: options?.signal
		});
		options?.onProgress?.({ type: 'status', message: 'Clone complete.' });
	}

	throwIfAborted(options?.signal);
	await ensureFullClone(repoPath, options?.onProgress, options?.signal);
	options?.onProgress?.({ type: 'status', message: 'Fast-forwarding to latest default branch...' });
	await runCommand('git', ['pull', '--ff-only'], {
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
				profileUrl: identity.profileUrl
			};
		});
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
		{ commits: Map<string, number>; name: string; profileUrl?: string }
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
		periods.push({ ...period, contributors });
		if ((index + 1) % progressStride === 0 || index === periodDefinitions.length - 1) {
			options?.onProgress?.({
				type: 'status',
				message: `Processed ${index + 1} of ${periodDefinitions.length} periods`
			});
		}

		for (const { author, commits, profileUrl } of contributors) {
			const contributorKey = profileUrl ?? author;
			const existing = contributorMap.get(contributorKey);
			if (existing) {
				existing.commits.set(period.label, commits);
				if (!existing.profileUrl && profileUrl) {
					existing.profileUrl = profileUrl;
				}
				continue;
			}

			const perPeriod = new Map<string, number>();
			perPeriod.set(period.label, commits);
			contributorMap.set(contributorKey, { commits: perPeriod, name: author, profileUrl });
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
