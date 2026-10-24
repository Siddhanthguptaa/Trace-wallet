import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ANVIL_CHAIN_ID, BASE_CHAIN_ID, loadConfig, parseEnvFile } from '../src/index.ts';

const tmp = mkdtempSync(join(tmpdir(), 'hypnexis-cfg-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('loadConfig', () => {
  it('fills the M0-checked defaults', () => {
    const c = loadConfig({}, { useEnvFile: false });
    expect(c.CHAIN_MODE).toBe('local');
    expect(c.chainId).toBe(ANVIL_CHAIN_ID);
    expect(c.FORK_BLOCK).toBe(53026000);
    expect(c.ENTRYPOINT_V08).toBe('0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108');
    expect(c.LLM_BASE_URL).toBe('http://localhost:11434/v1');
    expect(c.anvilRpcUrl).toBe('http://127.0.0.1:8545');
  });

  it('coerces env strings and switches chain id in fork mode', () => {
    const c = loadConfig({ CHAIN_MODE: 'fork', FORK_BLOCK: '123', ANVIL_PORT: '9545' }, { useEnvFile: false });
    expect(c.FORK_BLOCK).toBe(123);
    expect(c.chainId).toBe(BASE_CHAIN_ID);
    expect(c.anvilRpcUrl).toBe('http://127.0.0.1:9545');
  });

  it('rejects bad values', () => {
    expect(() => loadConfig({ USDC_BASE: '0x1234' }, { useEnvFile: false })).toThrow();
    expect(() => loadConfig({ CHAIN_MODE: 'mainnet' }, { useEnvFile: false })).toThrow();
  });

  it('reads <root>/.env under process env', () => {
    writeFileSync(join(tmp, '.env'), 'FORK_BLOCK=777\nLLM_MODEL="llama3:latest"\nANVIL_PORT=1111 # comment\n');
    const c = loadConfig({ ANVIL_PORT: '2222' }, { root: tmp });
    expect(c.FORK_BLOCK).toBe(777);
    expect(c.LLM_MODEL).toBe('llama3:latest');
    expect(c.ANVIL_PORT).toBe(2222);
    expect(c.root).toBe(tmp);
  });
});

describe('parseEnvFile', () => {
  it('skips comments and blanks, strips quotes and trailing comments', () => {
    expect(parseEnvFile('# c\n\nA=1\nexport B = "two"\nC=x # y\nbad line\n')).toEqual({ A: '1', B: 'two', C: 'x' });
  });
});
