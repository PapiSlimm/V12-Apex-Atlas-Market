import crypto from 'crypto';
import type { AuditEntry } from './types';

export const GENESIS_HASH = '0'.repeat(64);

/**
 * Canonical serialisation for hashing.
 *
 * Object key order must not affect the hash, or a round-trip through a
 * different driver (Postgres jsonb reorders keys; SQLite stores the text
 * verbatim) would appear to be tampering. Keys are sorted recursively.
 */
export function canonicalise(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalise(v)}`);
  return `{${entries.join(',')}}`;
}

type HashableEntry = Pick<
  AuditEntry,
  'seq' | 'id' | 'timestamp' | 'event' | 'actorId' | 'actorName' | 'actorRole' | 'subject' | 'outcome' | 'detail'
>;

/**
 * Each entry commits to its predecessor, so altering or deleting any historical
 * row invalidates every hash after it. This does not prevent tampering by
 * someone with write access to the database — nothing at this layer can — but
 * it makes tampering detectable, which is the achievable goal.
 */
export function hashEntry(entry: HashableEntry, prevHash: string): string {
  const payload = canonicalise({
    seq: entry.seq,
    id: entry.id,
    timestamp: entry.timestamp,
    event: entry.event,
    actorId: entry.actorId,
    actorName: entry.actorName,
    actorRole: entry.actorRole,
    subject: entry.subject,
    outcome: entry.outcome,
    detail: entry.detail,
  });
  return crypto.createHash('sha256').update(`${prevHash}:${payload}`).digest('hex');
}

/** Walks a chain in sequence order and reports the first inconsistency. */
export function verifyChain(entries: AuditEntry[]): {
  ok: boolean;
  entries: number;
  brokenAt?: number;
  reason?: string;
} {
  let prev = GENESIS_HASH;

  for (const entry of entries) {
    if (entry.prevHash !== prev) {
      return {
        ok: false,
        entries: entries.length,
        brokenAt: entry.seq,
        reason: 'Entry does not link to the previous hash — a record was removed or reordered.',
      };
    }
    const expected = hashEntry(entry, prev);
    if (expected !== entry.hash) {
      return {
        ok: false,
        entries: entries.length,
        brokenAt: entry.seq,
        reason: 'Recomputed hash does not match the stored hash — the record was modified.',
      };
    }
    prev = entry.hash;
  }

  return { ok: true, entries: entries.length };
}
