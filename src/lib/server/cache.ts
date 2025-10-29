import { mkdir, readFile, rename, writeFile, access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface CacheEntry<T> {
	value: T;
	updatedAt: string;
}

interface CacheFilePayload<T> {
	version: number;
	entries: Record<string, CacheEntry<T>>;
}

const CACHE_FILE_VERSION = 1;
const APP_STATE_DIR = 'contribs';

async function resolveAppStateDir(): Promise<string> {
	const base =
		process.env.XDG_STATE_HOME && process.env.XDG_STATE_HOME.trim().length > 0
			? process.env.XDG_STATE_HOME
			: join(homedir(), '.local', 'state');
	const target = join(base, APP_STATE_DIR);
	await mkdir(target, { recursive: true });
	return target;
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path, fsConstants.F_OK);
		return true;
	} catch {
		return false;
	}
}

export class PersistentCache<T> {
	private readonly entries = new Map<string, CacheEntry<T>>();
	private loaded = false;
	private loading: Promise<void> | null = null;
	private pendingWrite: Promise<void> | null = null;
	private pruneScheduler: NodeJS.Timeout | null = null;
	private readonly maxEntries?: number;
	private readonly maxAgeMs?: number;
	private readonly pruneIntervalMs: number;

	constructor(
		private readonly filename: string,
		options?: { maxEntries?: number; maxAgeMs?: number; pruneIntervalMs?: number }
	) {
		this.maxEntries = options?.maxEntries;
		this.maxAgeMs = options?.maxAgeMs;
		this.pruneIntervalMs = Math.max(60_000, options?.pruneIntervalMs ?? 5 * 60_000);
	}

	private async filePath(): Promise<string> {
		const dir = await resolveAppStateDir();
		return join(dir, this.filename);
	}

	private async ensureLoaded(): Promise<void> {
		if (this.loaded) {
			return;
		}
		if (this.loading) {
			await this.loading;
			return;
		}
		this.loading = (async () => {
			const path = await this.filePath();
			if (!(await fileExists(path))) {
				this.loaded = true;
				return;
			}
			try {
				const raw = await readFile(path, 'utf-8');
				const payload = JSON.parse(raw) as CacheFilePayload<T>;
				if (payload?.version !== CACHE_FILE_VERSION || typeof payload.entries !== 'object') {
					this.loaded = true;
					return;
				}
				for (const [key, record] of Object.entries(payload.entries)) {
					if (!record || typeof record !== 'object' || !('value' in record) || !('updatedAt' in record)) {
						continue;
					}
					this.entries.set(key, {
						value: record.value as T,
						updatedAt: String(record.updatedAt)
					});
				}
			} catch {
				// Ignore malformed cache files and start fresh
			} finally {
				this.loaded = true;
			}
		})();
		await this.loading;
		this.loading = null;
		this.schedulePrune();
	}

	private async persist(): Promise<void> {
		await this.ensureLoaded();
		if (this.pendingWrite) {
			await this.pendingWrite;
		}
		const writeOperation = (async () => {
			const path = await this.filePath();
			await mkdir(dirname(path), { recursive: true });
			const tmpPath = `${path}.${process.pid}.tmp`;
			const payload: CacheFilePayload<T> = {
				version: CACHE_FILE_VERSION,
				entries: Object.fromEntries(this.entries.entries())
			};
			await writeFile(tmpPath, JSON.stringify(payload, null, 2), 'utf-8');
			await rename(tmpPath, path);
		})();
		this.pendingWrite = writeOperation
			.catch(() => {
				// Swallow errors so the cache remains best effort
			})
			.finally(() => {
				this.pendingWrite = null;
			});
		await this.pendingWrite;
	}

	async get(key: string): Promise<CacheEntry<T> | undefined> {
		await this.ensureLoaded();
		const entry = this.entries.get(key);
		if (!entry) {
			return undefined;
		}
		if (this.maxAgeMs && Date.now() - Date.parse(entry.updatedAt) > this.maxAgeMs) {
			this.entries.delete(key);
			await this.persist();
			return undefined;
		}
		return entry;
	}

	async set(key: string, value: T): Promise<void> {
		await this.ensureLoaded();
		const now = new Date().toISOString();
		const existing = this.entries.get(key);
		if (existing && existing.value === value && existing.updatedAt === now) {
			return;
		}
		this.entries.set(key, { value, updatedAt: now });
		await this.persist();
		this.enforceLimits();
	}

	private enforceLimits(): void {
		if (this.maxEntries && this.entries.size > this.maxEntries) {
			const excess = this.entries.size - this.maxEntries;
			const sorted = Array.from(this.entries.entries()).sort(
				(a, b) => Date.parse(a[1].updatedAt) - Date.parse(b[1].updatedAt)
			);
			for (let i = 0; i < excess; i += 1) {
				const [key] = sorted[i];
				this.entries.delete(key);
			}
			void this.persist();
		}
		this.schedulePrune();
	}

	private schedulePrune(): void {
		if (this.pruneScheduler || !this.maxAgeMs) {
			return;
		}
		this.pruneScheduler = setTimeout(() => {
			this.pruneScheduler = null;
			void this.pruneExpired().catch(() => {
				// best effort
			});
		}, this.pruneIntervalMs);
	}

	private async pruneExpired(): Promise<void> {
		if (!this.maxAgeMs) {
			return;
		}
		await this.ensureLoaded();
		const now = Date.now();
		let removed = false;
		for (const [key, entry] of this.entries) {
			if (now - Date.parse(entry.updatedAt) > this.maxAgeMs) {
				this.entries.delete(key);
				removed = true;
			}
		}
		if (removed) {
			await this.persist();
		}
		this.schedulePrune();
	}

	async entriesList(): Promise<Array<[string, CacheEntry<T>]>> {
		await this.ensureLoaded();
		return Array.from(this.entries.entries());
	}
}

export function createPersistentCache<T>(
	filename: string,
	options?: { maxEntries?: number; maxAgeMs?: number; pruneIntervalMs?: number }
): PersistentCache<T> {
	return new PersistentCache<T>(filename, options);
}
