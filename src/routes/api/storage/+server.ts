import type { RequestHandler } from './$types';
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

export const GET: RequestHandler = async () => {
	const home = os.homedir();
	const gitPath = resolve(home, 'git');

	let gitBytes = 0;
	try {
		gitBytes = await directorySize(gitPath);
	} catch {
		gitBytes = 0;
	}

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

	return new Response(
		JSON.stringify({
			gitBytes,
			totalBytes,
			availableBytes,
			usedBytes
		}),
		{
			headers: {
				'content-type': 'application/json'
			}
		}
	);
};
