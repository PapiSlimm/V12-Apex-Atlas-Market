/**
 * Article I §1.2 / §1.3 — the cryptographic anchor and fail-closed boot.
 *
 * THERE IS NO BYPASS IN THIS FILE, AND THAT IS THE POINT
 * -----------------------------------------------------
 * §1.3 forbids a degraded start: "no bypass flag, no environment variable, and
 * no debug mode that disables enforcement in a production posture." So this
 * module reads no environment variable at all. Its only input is a directory
 * path, which exists so tests can point at a fixture — and a test fixture that
 * fails verification fails it exactly the same way production would.
 *
 * If you are here because the service will not start: the correct action is to
 * re-anchor deliberately with `npm run constitution:anchor`, which is a human
 * act with a diff, not to add a flag. An engineer who can silence this check
 * under deadline pressure is an engineer the Constitution does not constrain.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { load as loadYaml } from 'js-yaml';
import { adaptCanonical, isCanonicalSchema, type CanonicalConstitution } from './canonical';

export const CONSTITUTION_DIR = path.resolve(process.cwd(), 'constitution');
const YAML_FILE = 'constitution.yaml';
const LOCK_FILE = 'constitution.lock';

export interface ConstitutionDocument {
  instrument: string;
  ratification: string;
  entrenched_articles: string[];
  signatories: { id: string; name: string; role: string; direct_interface_origin?: boolean }[];
  sanctions: Record<string, { sanction: string; denies_action: boolean; [k: string]: unknown }>;
  escalation: { window_hours: number; count: number; ladder: Record<string, string> };
  time_limits_ms: Record<string, number>;
  inspectorate: {
    minimum_seated: number;
    ordinary_rule: string;
    unanimity_required_for: string[];
    seat_kind: string;
  };
  release_kinds: string[];
  city_world_destinations: string[];
  comptroller_verdicts: string[];
  money: Record<string, unknown>;
  tenancy: {
    isolation: string;
    application_layer_filtering_sufficient: boolean;
    backends_satisfying_2_1: string[];
  };
  explainability: {
    required_before_action: boolean;
    minimum_characters: number;
    must_name_inputs: boolean;
    must_name_threshold: boolean;
    vacuous_phrases: string[];
  };
  prohibited_classes: Record<string, { label: string; severity: string }>;
  oath: string[];
}

export interface AnchorResult {
  document: ConstitutionDocument;
  digest: string;
  ratification: string;
}

export class ConstitutionAnchorError extends Error {
  constructor(
    readonly reason:
      | 'absent'
      | 'unreadable'
      | 'unparseable'
      | 'digest_mismatch'
      | 'lock_absent'
      | 'entrenchment_violated',
    message: string,
  ) {
    super(message);
    this.name = 'ConstitutionAnchorError';
  }
}

/**
 * Distinguish "not there" from "there and unreachable".
 *
 * Checks the containing directory first: without its execute bit, every stat
 * inside it fails and every file in it looks absent.
 */
export type AccessCheck = (target: string, mode: number) => void;

/**
 * `access` is injectable ONLY so the unreadable-file branch can be tested.
 *
 * Running as root — which is how tests and many containers run — bypasses file
 * permission bits entirely, so a file at mode 000 is still readable and the
 * branch is unreachable. A seam a test can drive is better than a branch nobody
 * has ever executed. It defaults to the real check and nothing in production
 * passes anything else.
 */
function assertReadable(dir: string, file: string, label: string, access: AccessCheck = fs.accessSync): void {
  let dirReadable = true;
  try {
    access(dir, fs.constants.X_OK | fs.constants.R_OK);
  } catch {
    dirReadable = false;
  }

  if (!dirReadable) {
    /*
     * Three distinct faults, three distinct messages. A single "cannot read the
     * directory" would still leave whoever is reading the log guessing between
     * a missing COPY, a wrong mode, and a path that is not a directory at all —
     * which is the guessing this whole function exists to end.
     */
    if (!fs.existsSync(dir)) {
      throw new ConstitutionAnchorError(
        'absent',
        `${dir} does not exist, so ${label} cannot be read. Nothing copied the constitution into this image ` +
          'or onto this host. Article I §1.3: the service shall refuse to start.',
      );
    }
    if (!fs.statSync(dir).isDirectory()) {
      throw new ConstitutionAnchorError(
        'unreadable',
        `${dir} exists but is not a directory, so ${label} cannot be read. ` +
          'Article I §1.3: the service shall refuse to start.',
      );
    }
    throw new ConstitutionAnchorError(
      'unreadable',
      `${dir} exists and is a directory, but this process cannot traverse it (mode ` +
        `${(fs.statSync(dir).mode & 0o777).toString(8)}, uid ${typeof process.getuid === 'function' ? process.getuid() : '?'}), ` +
        `so ${label} cannot be read. A directory needs its EXECUTE bit — 555, not 444 — for anything inside it to be ` +
        'reachable. In a container this is usually `COPY --chmod=444` applied to a directory it created. ' +
        'Article I §1.3: the service shall refuse to start.',
    );
  }

  if (!fs.existsSync(file)) {
    const reason = label === LOCK_FILE ? 'lock_absent' : 'absent';
    const detail =
      reason === 'lock_absent'
        ? 'An unanchored Constitution is not a Constitution — re-anchor deliberately.'
        : 'Article I §1.3: the service shall refuse to start.';
    throw new ConstitutionAnchorError(reason, `${file} is absent. ${detail}`);
  }

  try {
    access(file, fs.constants.R_OK);
  } catch {
    throw new ConstitutionAnchorError(
      'unreadable',
      `${file} exists but is not readable by this process (uid ${typeof process.getuid === 'function' ? process.getuid() : '?'}). ` +
        'Article I §1.3: the service shall refuse to start.',
    );
  }
}

/** The digest is over the exact bytes on disk. Not over a re-serialisation, which would let formatting drift silently. */
export function digestOf(bytes: Buffer | string): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/**
 * Recompute and verify. Throws on any failure — callers must not catch this to
 * continue; the only correct response at boot is to stop.
 */
export function verifyAnchor(dir: string = CONSTITUTION_DIR, access?: AccessCheck): AnchorResult {
  const yamlPath = path.join(dir, YAML_FILE);
  const lockPath = path.join(dir, LOCK_FILE);

  /*
   * "ABSENT" AND "UNREADABLE" ARE DIFFERENT FAULTS, AND SAYING SO SAVES HOURS.
   *
   * `existsSync` returns FALSE for a file that is present but sits in a
   * directory this process cannot traverse — a directory without its execute
   * bit. The file is right there and the message says it is missing, which
   * sends whoever is reading the log looking for a lost COPY instead of a
   * wrong mode.
   *
   * That is not hypothetical. It is exactly how this deployment first failed:
   * `COPY --chmod=444` created /app/constitution with mode 444, the copy
   * genuinely succeeded, and the process reported the constitution absent.
   *
   * So the directory is probed separately, and each fault gets its own reason
   * and its own remedy.
   */
  assertReadable(dir, yamlPath, YAML_FILE, access);
  assertReadable(dir, lockPath, LOCK_FILE, access);

  const bytes = fs.readFileSync(yamlPath);
  const actual = digestOf(bytes);
  const recorded = fs.readFileSync(lockPath, 'utf8').trim().split(/\s+/)[0];

  if (actual !== recorded) {
    throw new ConstitutionAnchorError(
      'digest_mismatch',
      `Constitution digest mismatch.\n  recorded ${recorded}\n  actual   ${actual}\n` +
        'Article I §1.3: the service shall refuse to start. If this change is intended, ' +
        're-anchor it as a human act with a reviewable diff.',
    );
  }

  let parsed: unknown;
  try {
    parsed = loadYaml(bytes.toString('utf8'));
  } catch (err) {
    throw new ConstitutionAnchorError('unparseable', `constitution.yaml did not parse: ${(err as Error).message}`);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new ConstitutionAnchorError('unparseable', 'constitution.yaml parsed but is not a constitution.');
  }

  // The estate's canonical schema is Orion Prime's, which is the one deployed
  // and shared with the Inspectorate's host. It is adapted into this engine's
  // internal view rather than the other way round: the digest must be over the
  // estate's bytes, and how this process represents them in memory is nobody
  // else's business. See canonical.ts.
  const document: ConstitutionDocument = isCanonicalSchema(parsed)
    ? adaptCanonical(parsed as CanonicalConstitution)
    : (parsed as ConstitutionDocument);

  if (!document.instrument || !Array.isArray(document.entrenched_articles)) {
    throw new ConstitutionAnchorError('unparseable', 'constitution.yaml parsed but is not a constitution.');
  }

  assertEntrenchmentIntact(document);

  return { document, digest: actual, ratification: document.ratification };
}

/**
 * Article XII §12.4 — entrenched Articles may be tightened, never weakened.
 *
 * A full amendment diff is a human review problem, but a handful of relaxations
 * are mechanically detectable, and those are exactly the ones an agent under
 * pressure would attempt. The engine refuses the ruleset and refuses to start.
 */
function assertEntrenchmentIntact(document: ConstitutionDocument): void {
  const failures: string[] = [];

  for (const article of ['I', 'II', 'III', 'VII', 'X', 'XII', 'XIII']) {
    if (!document.entrenched_articles.includes(article)) {
      failures.push(`Article ${article} has been removed from entrenchment`);
    }
  }
  if (document.tenancy?.application_layer_filtering_sufficient === true) {
    failures.push('Article II §2.1 weakened: application-layer filtering declared sufficient');
  }
  if (document.money?.float_forbidden === false) {
    failures.push('Article III §3.1 weakened: floating-point money permitted');
  }
  if (document.money?.double_entry_required === false) {
    failures.push('Article III §3.2 weakened: double entry no longer required');
  }
  if (document.money?.margin_floor_absolute === false) {
    failures.push('Article III §3.5 weakened: the margin floor is no longer absolute');
  }
  if ((document.inspectorate?.minimum_seated ?? 0) < 3) {
    failures.push('Article XIII §13.4 weakened: quorum below three');
  }
  if (document.inspectorate?.seat_kind !== 'human_only') {
    failures.push('Article XIII §13.5 weakened: an Inspector General would no longer be human-only');
  }
  if (document.explainability?.required_before_action === false) {
    failures.push('Article V §5.1 weakened: rationale no longer required before action');
  }

  if (failures.length > 0) {
    throw new ConstitutionAnchorError(
      'entrenchment_violated',
      `An amendment purporting to weaken an entrenched Article is void (Article XII §12.4):\n  - ${failures.join('\n  - ')}`,
    );
  }
}

/**
 * Writes the lock. Deliberately a separate, explicit human act — never called
 * at boot.
 *
 * The format is a BARE 64-character digest, no filename and no trailing
 * newline, because that is what Orion Prime and Nexion already have on disk and
 * this file is meant to be byte-identical across the estate. I originally wrote
 * `sha256sum` format here; re-anchoring in Apex would then have silently forked
 * the lock away from the other two. Caught by a round-trip test, which is the
 * only reason it is not still true.
 */
export function anchor(dir: string = CONSTITUTION_DIR): { digest: string } {
  const yamlPath = path.join(dir, YAML_FILE);
  const bytes = fs.readFileSync(yamlPath);
  const digest = digestOf(bytes);
  fs.writeFileSync(path.join(dir, LOCK_FILE), digest);
  return { digest };
}
