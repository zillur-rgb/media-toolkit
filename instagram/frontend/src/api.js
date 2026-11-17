export async function resolveLink(url) {
  const r = await fetch('/api/ig/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  const data = await r.json().catch(() => ({ error: `Server error (${r.status})` }));
  if (!r.ok) throw new Error(data.error || `Server error (${r.status})`);
  return data;
}

export const mediaUrl = (u) => `/api/ig/media?u=${encodeURIComponent(u)}`;
export const downloadUrl = (u, name) => `/api/ig/media?u=${encodeURIComponent(u)}&dl=1&name=${encodeURIComponent(name)}`;

export function formatCount(n) {
  if (n === null || n === undefined) return '';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}K`;
  return n.toLocaleString();
}
