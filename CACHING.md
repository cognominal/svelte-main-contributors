# Caching mechanism

## Overview

The application uses a two-tier caching strategy combining in-memory
Maps with file-based persistent storage to minimize GitHub API calls
and improve performance across invocations.

## Core implementation

### Persistent cache class

**File:** [src/lib/server/cache.ts][cache-impl]

The `PersistentCache<T>` class provides a generic, file-based caching
layer with the following characteristics:

#### Storage

- **Location:** `$XDG_STATE_HOME/contribs/` or
  `~/.local/state/contribs/`
- **Format:** JSON files with versioned payloads
- **Atomicity:** Writes use temporary files with atomic rename operations
  to prevent corruption
- **In-memory backup:** Uses `Map<string, CacheEntry<T>>` for fast access

#### Cache entry structure

```typescript
interface CacheEntry<T> {
  value: T;
  updatedAt: string;  // ISO-8601 timestamp
}
```

#### File format

```typescript
interface CacheFilePayload<T> {
  version: number;            // Currently 1
  entries: Record<string, CacheEntry<T>>;
}
```

#### Configuration options

```typescript
constructor(
  filename: string,
  options?: {
    maxEntries?: number;      // Maximum cache size
    maxAgeMs?: number;         // Time-to-live in milliseconds
    pruneIntervalMs?: number;  // Prune check interval
                               // (min 60s, default 5min)
  }
)
```

#### Key features

- **TTL-based expiration:** Entries older than `maxAgeMs` are
  automatically removed
- **Size limits:** When `maxEntries` is exceeded, oldest entries
  (by `updatedAt`) are evicted first (LRU-style)
- **Background pruning:** Scheduled task runs every `pruneIntervalMs`
  (default: 5 minutes) to remove stale entries
- **Lazy loading:** Cache files are loaded on first access
- **Best-effort persistence:** Write failures are swallowed to keep the
  cache non-blocking

#### Key methods

- `get(key: string)`: Retrieves entry; removes and returns `undefined`
  if expired
- `set(key: string, value: T)`: Stores/updates entry with current
  timestamp
- `entriesList()`: Returns all entries as an array
- `persist()`: Asynchronously writes cache to disk
- `pruneExpired()`: Removes all stale entries
- `enforceLimits()`: Enforces size limits and triggers pruning

## GitHub profile caching

**File:** [src/lib/server/gitStats.ts][gitstats-impl]

The application caches GitHub profile URLs to avoid repeated API
lookups when resolving contributor identities from git commit metadata.

### Cache stores

Two separate persistent caches are maintained:

```typescript
const githubProfileStore = createPersistentCache<string | null>(
  'github-profiles-by-email.json'
);

const githubNameStore = createPersistentCache<string | null>(
  'github-profiles-by-name.json'
);
```

Each persistent store is paired with an in-memory Map for fast access:

```typescript
const githubProfileCache = new Map<string, string | null>();
const githubNameCache = new Map<string, string | null>();
```

### Cache key generation

#### Email-based lookups

- **Input:** `email: string`
- **Normalization:** `normalizeEmail()` → `trim().toLowerCase()`
- **Cache key:** Normalized email string
- **Cached value:** GitHub profile URL (string) or `null` (not found)

#### Name-based lookups

- **Input:** `name: string`
- **Normalization:** `normalizeName()` →
  - NFKD decomposition
  - Remove accent marks
  - Lowercase
  - Remove non-alphanumeric characters
- **Cache key:** Normalized name string
- **Cached value:** GitHub profile URL (string) or `null` (not found)

### Cached data

- **GitHub profile URLs:** Links to user profiles
  (e.g., `https://github.com/username`)
- **Null values:** Explicitly cached to avoid repeated failed lookups
  for the same contributor
- **Purpose:** Speed up contributor identity resolution across multiple
  repository analyses

### Cache hydration

Two hydration functions load data from persistent storage into memory:

- `hydrateEmailProfileCache(normalizedEmail)`: Loads email→profile
  mapping
- `hydrateNameProfileCache(normalizedName)`: Loads name→profile mapping

### Lookup workflow

1. **Memory check:** Search in-memory Map first
2. **Disk check:** If not in memory, hydrate from persistent store
3. **API fallback:** If still not cached, fetch from GitHub API
4. **Write-back:** Store result in both in-memory Map and persistent
   cache

### Lookup methods

- `lookupProfileUrlFromGitHub()`: Primary method that tries:
  1. Derive profile from email patterns
     (`*@users.noreply.github.com`, `*@github.com`)
  2. Fetch commit metadata from GitHub API
  3. Search by name if email lookup fails
- `lookupProfileUrlByName()`: Searches GitHub users by name and
  evaluates candidates

### Cache invalidation

- **No explicit TTL** in the current implementation
- Caches persist indefinitely unless:
  - Cache files are manually deleted
  - Size limits are enforced (if configured)
- **Rationale:** GitHub profile URLs rarely change, and explicit null
  caching prevents API spam

## Usage example

```typescript
import { createPersistentCache } from '$lib/server/cache';

const myCache = createPersistentCache<string>('my-data.json', {
  maxEntries: 1000,
  maxAgeMs: 24 * 60 * 60 * 1000,  // 1 day
  pruneIntervalMs: 60 * 60 * 1000  // 1 hour
});

// Retrieve cached value
const entry = await myCache.get('some-key');
if (entry) {
  console.log('Cached value:', entry.value);
  console.log('Last updated:', entry.updatedAt);
}

// Store new value
await myCache.set('some-key', 'some-value');

// List all entries
const allEntries = await myCache.entriesList();
```

## Performance characteristics

| Aspect | Details |
|--------|---------|
| **Read latency** | ~1ms (in-memory) to ~10ms (disk load) |
| **Write latency** | ~5-20ms (atomic file write) |
| **Memory overhead** | Proportional to cache size |
| **Disk overhead** | JSON serialization, ~100-500 bytes per entry |
| **Concurrency** | Safe for single-process use; no multi-process |
|                  | locking |

## Maintenance

### Clearing cache

```bash
rm -rf ~/.local/state/contribs/
```

### Cache file locations

- `~/.local/state/contribs/github-profiles-by-email.json`
- `~/.local/state/contribs/github-profiles-by-name.json`

### Debugging cache behavior

The cache files are human-readable JSON. You can inspect them directly:

```bash
cat ~/.local/state/contribs/github-profiles-by-email.json | jq .
```

[cache-impl]: src/lib/server/cache.ts
[gitstats-impl]: src/lib/server/gitStats.ts
