/**
 * Client-only GitHub API functions
 * This module contains all fetch calls and must only be imported/used on the client side
 */

interface GitHubHeaders {
	Accept: string;
	Authorization?: string;
}

function getGitHubHeaders(): GitHubHeaders {
	const headers: GitHubHeaders = {
		Accept: 'application/vnd.github+json'
	};

	if (import.meta.env.VITE_GITHUB_TOKEN) {
		headers.Authorization = `Bearer ${import.meta.env.VITE_GITHUB_TOKEN}`;
	}

	return headers;
}

export async function fetchJSON<T>(url: string, signal: AbortSignal): Promise<T> {
	const response = await fetch(url, {
		headers: getGitHubHeaders(),
		signal
	});

	if (!response.ok) {
		throw new Error(`GitHub request failed (${response.status})`);
	}

	return (await response.json()) as T;
}

export async function validateGitHubUser(login: string, signal: AbortSignal): Promise<boolean> {
	try {
		const response = await fetch(`https://api.github.com/users/${login}`, {
			signal,
			headers: getGitHubHeaders()
		});

		return response.ok;
	} catch (error) {
		if ((error as Error).name === 'AbortError') {
			throw error;
		}
		return false;
	}
}

export async function validateGitHubRepo(
	ownerLogin: string,
	repoName: string,
	signal: AbortSignal
): Promise<boolean> {
	try {
		const response = await fetch(`https://api.github.com/repos/${ownerLogin}/${repoName}`, {
			signal,
			headers: getGitHubHeaders()
		});

		return response.ok;
	} catch (error) {
		if ((error as Error).name === 'AbortError') {
			throw error;
		}
		return false;
	}
}

interface GitHubUserSearchResult {
	total_count: number;
	items: Array<{ login: string }>;
}

export async function searchGitHubUsers(
	query: string,
	signal: AbortSignal
): Promise<GitHubUserSearchResult> {
	return fetchJSON<GitHubUserSearchResult>(
		`https://api.github.com/search/users?q=${encodeURIComponent(`${query} in:login`)}&per_page=20`,
		signal
	);
}

interface GitHubRepoSearchResult {
	total_count: number;
	items: Array<{ name: string; full_name: string }>;
}

export async function searchGitHubRepos(
	ownerLogin: string,
	prefix: string,
	signal: AbortSignal
): Promise<GitHubRepoSearchResult> {
	return fetchJSON<GitHubRepoSearchResult>(
		`https://api.github.com/search/repositories?q=${encodeURIComponent(`user:${ownerLogin} ${prefix} in:name`)}&per_page=20`,
		signal
	);
}
