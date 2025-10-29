import type { PageServerLoad } from './$types';
import { statfs, opendir, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import os from 'node:os';

async function directorySize(root: string): Promise<number> {
	let total = 0;
	try {
		const dir = await opendir(root);
		for await (const dirent of dir) {
			const fullPath = join(root, dirent.name);
			try {
				const stat = await lstat(fullPath);
				if (stat.isSymbolicLink()) {
					continue;
				}
				if (stat.isDirectory()) {
					total += await directorySize(fullPath);
				} else {
					total += stat.size;
				}
			} catch {
				// Ignore entries that disappear during traversal
			}
		}
	} catch {
		// If the directory can't be opened, treat it as empty
	}
	return total;
}

export const load: PageServerLoad = async ({ cookies }) => {
	const queryJson = cookies.get('contribs_query');

	const home = os.homedir();
	const gitPath = resolve(home, 'git');

	// Skip expensive directory size calculation during SSR - it blocks page load
	// TODO: Calculate this on-demand via an API endpoint instead
	let gitBytes = 0;

	let totalBytes = 0;
	let availableBytes = 0;
	let usedBytes = 0;

	try {
		const stats = await statfs(gitPath);
		const blockSize = stats.bsize ?? 4096;
		totalBytes = (stats.blocks ?? 0) * blockSize;
		const freeBlocks = stats.bfree ?? 0;
		const availBlocks = stats.bavail ?? freeBlocks;
		availableBytes = availBlocks * blockSize;
		usedBytes = totalBytes - freeBlocks * blockSize;
	} catch {
		// fall back to root filesystem stats
		const stats = await statfs('/');
		const blockSize = stats.bsize ?? 4096;
		totalBytes = (stats.blocks ?? 0) * blockSize;
		const freeBlocks = stats.bfree ?? 0;
		const availBlocks = stats.bavail ?? freeBlocks;
		availableBytes = availBlocks * blockSize;
		usedBytes = totalBytes - freeBlocks * blockSize;
	}

	const storageInfo = {
		gitBytes,
		totalBytes,
		availableBytes,
		usedBytes
	};

	if (!queryJson) {
		return { savedQuery: null, storageInfo };
	}

	try {
		const savedQuery = JSON.parse(queryJson) as {
			owner?: string;
			repo?: string | null;
			limit?: number;
			excludeBots?: boolean;
			topStarred?: boolean;
		};
		return { savedQuery, storageInfo };
	} catch {
		return { savedQuery: null, storageInfo };
	}
};
