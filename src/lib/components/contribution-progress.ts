import type { ProgressEvent } from "$lib/server/gitStats";

export const MAX_PROGRESS_ENTRIES = 20;

export type ProgressEntry = {
  id: string;
  message: string;
  timestamp: number;
  kind: "status" | "git";
  command?: string;
};

export type StreamEvent =
  | { type: "status"; message: string }
  | {
      type: "git";
      command: string;
      stream: "stdout" | "stderr";
      text: string;
    };

export function appendProgressEntry(
  entries: ProgressEntry[],
  entry: ProgressEntry,
  maxEntries: number = MAX_PROGRESS_ENTRIES,
): ProgressEntry[] {
  const next = [...entries, entry];
  return next.length > maxEntries
    ? next.slice(next.length - maxEntries)
    : next;
}

export function appendProgressStatus(
  entries: ProgressEntry[],
  message: string,
  maxEntries: number = MAX_PROGRESS_ENTRIES,
): ProgressEntry[] {
  if (!message) return entries;
  const trimmed = message.trim();
  if (!trimmed) return entries;
  const timestamp = Date.now();
  const last = entries[entries.length - 1];
  if (last && last.kind === "status" && last.message === trimmed) {
    return [
      ...entries.slice(0, -1),
      { ...last, timestamp },
    ];
  }

  return appendProgressEntry(
    entries,
    {
      id: `${timestamp}-${Math.random()}`,
      message: trimmed,
      timestamp,
      kind: "status",
    },
    maxEntries,
  );
}

export function upsertProgressGitEntry(
  entries: ProgressEntry[],
  {
    command,
    text,
    gitEntryLookup,
    maxEntries = MAX_PROGRESS_ENTRIES,
  }: {
    command: string;
    text: string | undefined;
    gitEntryLookup: Map<string, string>;
    maxEntries?: number;
  },
): ProgressEntry[] {
  if (!text) {
    return entries;
  }

  const trimmed = text.trim();
  if (!trimmed) {
    return entries;
  }

  const timestamp = Date.now();
  const safeCommand = command || "git";
  const label = `[${safeCommand}] ${trimmed}`;
  const existingId = gitEntryLookup.get(safeCommand);
  if (existingId) {
    const existingEntry = entries.find((entry) => entry.id === existingId);
    if (!existingEntry) {
      gitEntryLookup.delete(safeCommand);
      const id = `${timestamp}-${Math.random()}`;
      gitEntryLookup.set(safeCommand, id);
      return appendProgressEntry(
        entries,
        {
          id,
          message: label,
          timestamp,
          kind: "git",
          command: safeCommand,
        },
        maxEntries,
      );
    }

    const updatedEntry: ProgressEntry = {
      ...existingEntry,
      message: label,
      timestamp,
    };

    const filtered = entries.filter((entry) => entry.id !== existingId);
    const next = [...filtered, updatedEntry];
    return next.length > maxEntries
      ? next.slice(next.length - maxEntries)
      : next;
  }

  const id = `${timestamp}-${Math.random()}`;
  gitEntryLookup.set(safeCommand, id);
  return appendProgressEntry(
    entries,
    {
      id,
      message: label,
      timestamp,
      kind: "git",
      command: safeCommand,
    },
    maxEntries,
  );
}

export function applyProgressEvent(
  entries: ProgressEntry[],
  event: StreamEvent | ProgressEvent,
  gitEntryLookup: Map<string, string>,
  maxEntries: number = MAX_PROGRESS_ENTRIES,
): ProgressEntry[] {
  if (event.type === "status") {
    return appendProgressStatus(entries, event.message, maxEntries);
  }
  if (event.type === "git") {
    return upsertProgressGitEntry(entries, {
      command: event.command,
      text: event.text,
      gitEntryLookup,
      maxEntries,
    });
  }
  return entries;
}
