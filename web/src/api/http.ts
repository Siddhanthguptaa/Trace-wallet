import type { z } from 'zod';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly kind: 'not-configured' | 'network' | 'http' | 'schema' | 'timeout',
    readonly status?: number,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type Init = { method?: 'GET' | 'POST'; body?: unknown; timeoutMs?: number; signal?: AbortSignal };

/**
 * Fetch JSON from a real backend and validate it. A malformed response is an error state,
 * never a crash and never silently trusted.
 */
export async function request<S extends z.ZodType>(
  base: string | undefined,
  service: string,
  path: string,
  schema: S,
  init: Init = {},
): Promise<z.output<S>> {
  if (!base) {
    throw new ApiError(`${service} URL is not set`, 'not-configured', undefined, `Set the ${service} URL in .env.local`);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 12_000);
  init.signal?.addEventListener('abort', () => ctrl.abort());
  let res: Response;
  try {
    res = await fetch(base + path, {
      method: init.method ?? 'GET',
      headers: init.body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: init.body !== undefined ? JSON.stringify(init.body, bigintReplacer) : undefined,
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if ((e as Error).name === 'AbortError') throw new ApiError(`${service} did not answer in time`, 'timeout');
    throw new ApiError(`Can't reach the ${service}`, 'network', undefined, (e as Error).message);
  }
  clearTimeout(timer);
  let json: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      throw new ApiError(`${service} sent a response that is not JSON`, 'schema', res.status);
    }
  }
  if (!res.ok) {
    const msg =
      json && typeof json === 'object' && 'error' in json && typeof (json as { error: unknown }).error === 'string'
        ? (json as { error: string }).error
        : `${service} answered ${res.status}`;
    throw new ApiError(msg, 'http', res.status);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new ApiError(
      `${service} sent data in an unexpected shape`,
      'schema',
      res.status,
      parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; '),
    );
  }
  return parsed.data;
}

export function bigintReplacer(_k: string, v: unknown): unknown {
  return typeof v === 'bigint' ? v.toString() : v;
}
