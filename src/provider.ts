// Bounded JSON reads from paid providers (OpenRouter, Exa, Resend): status checked, size capped, keys never echoed.
export async function providerJson(res: Response, label: string, limit = 256 * 1024): Promise<any> {
  if (!res.ok) { await res.body?.cancel(); throw new Error(`${label} returned HTTP ${res.status}`); }
  const reader = res.body?.getReader();
  if (!reader) throw new Error(`${label} returned no response`);
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw new Error(`${label} response exceeded its size limit`); }
    chunks.push(value);
  }
  return JSON.parse(await new Blob(chunks as BlobPart[]).text());
}

/** Removes the given secrets and bearer-shaped strings from an error before it is stored or shown. */
export function redact(message: string, secrets: (string | undefined)[]): string {
  let out = message;
  for (const key of secrets) if (key) out = out.replaceAll(key, "[redacted]");
  return out.replace(/Bearer\s+\S+|sk-or-[A-Za-z0-9-]+|re_[A-Za-z0-9_]{10,}/gi, "[redacted]");
}

/** OpenRouter's strict json_schema mode rejects "format" keywords; validation stays local (zod). */
export const strictSchema = (schema: unknown) => JSON.parse(JSON.stringify(schema, (key, value) => key === "format" ? undefined : value));
