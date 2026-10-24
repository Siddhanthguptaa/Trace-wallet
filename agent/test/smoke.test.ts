import { describe, expect, it } from 'vitest';
import { loadConfig } from '@hypnexis/shared';
import { createLlmClient, PACKAGE } from '../src/index.ts';

describe('agent package', () => {
  it('builds an LLM client from config (default local Ollama)', () => {
    const { client, model } = createLlmClient(loadConfig({}, { useEnvFile: false }));
    expect(PACKAGE).toBe('@hypnexis/agent');
    expect(client.baseURL).toBe('http://localhost:11434/v1');
    expect(model).toBe('qwen2.5-coder:7b');
  });
});
