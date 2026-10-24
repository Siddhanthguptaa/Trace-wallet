/**
 * D3 shared pieces (ATT lane): tier rule + EIP-712 types. Not re-exported from the package root
 * (packages/shared/src/index.ts is frozen during waves); import this file directly until INT adds
 * an "./attestor" subpath export.
 */
export * from './tier.ts';
export * from './typedData.ts';
