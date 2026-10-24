# Statement (source: D:\Hacks\Hypnexis\Problem_Statements_hypn.pptx, slide 9)

Event: Hypnexis hackathon. Deck: "Problem Statements — 6 tracks · 15 problem statements".
Track 02 · Web3 & Blockchain (track has two PS: W3-01 Zero-Knowledge Eligibility Credentials, W3-02 Agent Wallet).

## W3-02 · Agent Wallet — Letting AI Agents Pay Safely

PROBLEM STATEMENT
AI agents increasingly buy things for users: API credits, tickets, groceries. Build an ERC-4337 account-abstraction smart-contract wallet that gives an AI agent a key able to spend only within an owner-defined policy.

EXPLANATION
The agent's key might leak, or a malicious webpage might manipulate the agent. The wallet's policies must hold even if the agent misbehaves.
Policies must cover: allowed contracts and functions; per-transaction limits; daily limits; allowed recipients; permission expiry; and owner approval for transactions outside the policy. The agent can be any open model or a scripted bot.

KEY CHALLENGES
- Correctly validating signatures, nonces and chain IDs
- Expressing policies precisely
- Requiring owner approval for out-of-policy requests

## Deck-wide notes
- No judging rubric released for this track. Only CL-04 (MathWorks) lists a rubric.
- No dataset supplied for W3-02.
