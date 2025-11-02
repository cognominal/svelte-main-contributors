import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { OwnerMap } from '$lib/types';

const gitRoot = process.env.GIT_ROOT ?? path.join(process.env.HOME ?? '', 'git');
let cachedMap: OwnerMap | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 30_000;

function toOwnerMap(entries: Array<{ owner: string; repo: string }>): OwnerMap {
	const map: OwnerMap = {};
	for (const { owner, repo } of entries) {
		if (!map[owner]) {
			map[owner] = [];
		}
		if (!map[owner].includes(repo)) {
			map[owner].push(repo);
		}
	}
	for (const owner of Object.keys(map)) {
		map[owner].sort((a, b) => a.localeCompare(b));
	}
	return map;
}

async function readGitDirectory(): Promise<Array<{ owner: string; repo: string }>> {
	try {
		const dirents = await readdir(gitRoot, { withFileTypes: true });
		const pairs: Array<{ owner: string; repo: string }> = [];
		for (const dirent of dirents) {
			if (!dirent.isDirectory()) {
				continue;
			}
			const [owner, ...rest] = dirent.name.split('---');
			if (!owner || rest.length === 0) {
				continue;
			}
			const repo = rest.join('---').trim();
			if (!repo) {
				continue;
			}
			pairs.push({ owner, repo });
		}
		return pairs;
	} catch (error) {
		console.error('Failed to read local git directory', error);
		return [];
	}
}

export async function loadOwnerMap(): Promise<OwnerMap> {
	const now = Date.now();
	if (cachedMap && now - cachedAt < CACHE_TTL_MS) {
		return cachedMap;
	}
	const entries = await readGitDirectory();
	cachedMap = toOwnerMap(entries);
	cachedAt = now;
	return cachedMap;
}

export function invalidateOwnerMapCache(): void {
	cachedMap = null;
	cachedAt = 0;
}
