/**
 * Attestation fetch (docs/api.md 15.1, tools rule): only a 200 with an `attestation` field upgrades
 * a payee. Any non-200, a timeout, a malformed body or the service being down means UNPROVEN
 * (empty slot). Never treat a missing attestation as PROVEN [A20].
 */
import type { Address, Hex } from 'viem';

export interface AttestResult {
  attestation: Hex;
  tier: 'PROVEN' | 'UNPROVEN' | 'FLAGGED';
  status: number | 'down';
  code?: string | null;
}

export async function fetchAttestation(baseUrl: string, wallet: Address, payee: Address, chainId: number, timeoutMs = 2000): Promise<AttestResult> {
  const url = `${baseUrl.replace(/\/$/, '')}/v1/attest?wallet=${wallet}&payee=${payee}&chainId=${chainId}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const body = (await res.json().catch(() => ({}))) as { attestation?: string; tier?: string; code?: string | null };
    if (res.status === 200 && typeof body.attestation === 'string' && /^0x[0-9a-fA-F]+$/.test(body.attestation) && body.tier === 'PROVEN')
      return { attestation: body.attestation as Hex, tier: 'PROVEN', status: 200, code: body.code ?? null };
    return { attestation: '0x', tier: body.tier === 'FLAGGED' ? 'FLAGGED' : 'UNPROVEN', status: res.status, code: body.code ?? null };
  } catch {
    return { attestation: '0x', tier: 'UNPROVEN', status: 'down' };
  }
}
