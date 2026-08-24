/**
 * Vault frontmatter parsing.
 *
 * Obsidian frontmatter is YAML, so this uses a real YAML parser rather than a
 * hand-rolled one. Writing a YAML subset by hand is a well-known way to be
 * subtly wrong about indentation, quoting and type coercion for years.
 *
 * The one thing YAML does not know about is Obsidian's `[[Wiki-Link]]`. To a
 * YAML parser that is a nested flow sequence:
 *
 *   parent_hub: [[City-Detroit]]        ->  [['City-Detroit']]
 *   downstream: [ [[W-A]], [[W-B]] ]    ->  [[['W-A']], [['W-B']]]
 *
 * Both collapse correctly under a deep flatten, which is what `links()` does.
 * That is not a trick — a link and a list of links genuinely differ only in
 * nesting depth, and flattening is the shape-independent read.
 */

import { load } from 'js-yaml';

export interface Frontmatter {
  data: Record<string, unknown>;
  body: string;
  /** Set when the block exists but does not parse. Never thrown. */
  error?: string;
}

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseFrontmatter(content: string): Frontmatter {
  const match = FENCE.exec(content);
  if (!match) return { data: {}, body: content };

  const body = content.slice(match[0].length);

  try {
    const loaded = load(match[1]);
    if (loaded === null || loaded === undefined) return { data: {}, body };
    if (typeof loaded !== 'object' || Array.isArray(loaded)) {
      return { data: {}, body, error: 'Frontmatter is not a mapping.' };
    }
    return { data: loaded as Record<string, unknown>, body };
  } catch (err) {
    // A malformed vault file must not take down the graph — it becomes one
    // reported issue on one node, and every other node still parses.
    return { data: {}, body, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Every wiki-link in a value, regardless of how deeply the parser nested it. */
export function links(value: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      const trimmed = v.trim();
      if (trimmed) out.push(trimmed);
      return;
    }
    if (Array.isArray(v)) v.forEach(walk);
  };
  walk(value);
  return out;
}

/** The first wiki-link in a value, or null. For single-valued fields. */
export const link = (value: unknown): string | null => links(value)[0] ?? null;

export function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * A finite number, or null.
 *
 * Strings are accepted because a vault is edited by humans, and `"12.50"` in a
 * YAML file is a typo in quoting rather than a statement that the cost is
 * unknown. `NaN` and `Infinity` are rejected: they would propagate silently
 * through every downstream total.
 */
export function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** A list of mappings, e.g. `multimedia_production_lines`. Tolerates a single mapping. */
export function rows(value: unknown): Record<string, unknown>[] {
  const isRow = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

  if (isRow(value)) return [value];
  if (Array.isArray(value)) return value.filter(isRow);
  return [];
}
