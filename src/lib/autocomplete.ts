export async function fetchJSON<T>(url: string, signal: AbortSignal): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
  };
  if (import.meta.env.VITE_GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${import.meta.env.VITE_GITHUB_TOKEN}`;
  }

  const response = await fetch(url, { headers, signal });
  if (!response.ok) {
    throw new Error(`GitHub request failed (${response.status})`);
  }
  return (await response.json()) as T;
}