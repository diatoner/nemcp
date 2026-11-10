import { createHash } from 'node:crypto';
import { strFromU8, unzipSync } from 'fflate';

export const NEMWEB_BASE = process.env.NEMWEB_BASE ?? 'https://nemweb.com.au';
const UA = 'nem-mcp (public-utility prototype)';

/** List .zip links in a NEMWeb directory listing that match a pattern. */
export async function listZips(dir: string, pattern: RegExp): Promise<string[]> {
  const res = await fetch(new URL(dir, NEMWEB_BASE), { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} listing ${dir}`);
  const html = await res.text();
  const urls = new Set<string>();
  for (const m of html.matchAll(/href="([^"]+\.zip)"/gi)) {
    const href = m[1];
    if (pattern.test(href)) urls.add(new URL(href, new URL(dir, NEMWEB_BASE)).toString());
  }
  return [...urls].sort(); // filenames embed timestamps, so lexical sort = time order
}

export interface FetchedCsv {
  url: string;
  name: string;   // zip filename
  sha256: string; // of the zip bytes
  csv: string;
}

/** Download a zip and return its single CSV. ⚠️ ARCHIVE zips contain zips; handle at M2. */
export async function fetchZipCsv(url: string): Promise<FetchedCsv> {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const files = unzipSync(bytes);
  const csvName = Object.keys(files).find((n) => n.toUpperCase().endsWith('.CSV'));
  if (!csvName) throw new Error(`No CSV inside ${url}`);
  return { url, name: url.split('/').pop()!, sha256, csv: strFromU8(files[csvName]) };
}
