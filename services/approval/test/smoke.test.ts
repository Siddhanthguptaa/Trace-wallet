import { describe, expect, it } from 'vitest';
import { loadConfig } from '@hypnexis/shared';
import { createApp, SERVICE } from '../src/index.ts';

describe('approval scaffold', () => {
  it('answers /health and sees the shared config', async () => {
    const res = await createApp().request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ service: SERVICE, ok: true });
    expect(loadConfig({}, { useEnvFile: false }).CHAIN_MODE).toBe('local');
  });
});
