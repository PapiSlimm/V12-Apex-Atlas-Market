/**
 * The digital twin: vault markdown in, a typed and validated supply graph out.
 *
 * The vault is the source of truth. Nothing in here writes.
 */

export * from './types';
export { parseFrontmatter, links, link, num, str, rows } from './frontmatter';
export { buildGraph, validate, slugOf, linesFor, fundamentalsIntact } from './graph';
export {
  valueBlock,
  valueEcosystem,
  SPEC_MANDATE,
  type BlockValuation,
  type EcosystemValuation,
  type FeeTable,
  type LineSummary,
  type MandatePolicy,
  type WarehouseSummary,
} from './valuation';
