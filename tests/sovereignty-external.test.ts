import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs';

import { verifyAnchor } from '../server/constitution/anchor';
import { Inspectorate, determinationCanonical } from '../server/constitution/release';
import { SOVEREIGN, certifySovereign, refuseForeignCertificate } from '../server/constitution/sovereignty';
import type { Determination, Rationale, ReleaseCandidate } from '../server/constitution/types';
import { issueKey, verifyKey, parsePresented, hashSecret, RateLimiter, SCOPES, type ExternalKeyRecord } from '../server/external/keys';
import { EXTERNAL_ROUTES } from '../server/external/router';

const { document: DOC } = verifyAnchor();

// ===========================================================================
// Sovereignty — Apex seats its own Inspectorate and defers to nobody
// ===========================================================================

const RATIONALE: Rationale = {
  summary: 'Deployed build 412 because the migration is reversible and the rollback was rehearsed on 2 replicas.',
  inputs: { build: 412, replicas: 2 },
  threshold: { name: 'rollback_rehearsed', value: 'yes' },
  language: 'en-GB',
};

const CANDIDATE: ReleaseCandidate = {
  id: 'rel-sov',
  kind: 'production_deployment',
  risk: 'ordinary',
  tenantId: 'tenant-a',
  proposedBy: 'deploy-agent',
  payloadDigest: 'digest-1',
  rationale: RATIONALE,
};

function inspector(id: string) {
  const keys = crypto.generateKeyPairSync('ed25519');
  return {
    seat: {
      id, name: id, kind: 'human' as const,
      publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
      seatedAt: Date.now(),
    },
    privateKey: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  };
}

function concur(ig: ReturnType<typeof inspector>, candidate: ReleaseCandidate): Determination {
  const at = Date.now();
  const reasons = 'Reviewed the change set; the migration is reversible and rollback was rehearsed.';
  const canonical = determinationCanonical({
    candidateId: candidate.id, payloadDigest: candidate.payloadDigest,
    inspectorId: ig.seat.id, concurs: true, reasons, at,
  });
  const signature = crypto
    .sign(null, Buffer.from(canonical, 'utf8'), crypto.createPrivateKey({
      key: Buffer.from(ig.privateKey, 'base64'), format: 'der', type: 'pkcs8',
    }))
    .toString('base64');
  return { inspectorId: ig.seat.id, concurs: true, reasons, at, signature };
}

test('Apex is under V12 Multimedia and outside the ecosystem', () => {
  assert.equal(SOVEREIGN.parent, 'V12 Multimedia');
  assert.equal(SOVEREIGN.memberOfEcosystem, false);
  assert.equal(SOVEREIGN.inspectorate, 'own');
});

test("Apex's own Inspectorate certifies, and names itself as the source", () => {
  const inspectorate = new Inspectorate(DOC);
  const igs = [inspector('ig-a'), inspector('ig-b'), inspector('ig-c')];
  igs.forEach((i) => inspectorate.seat(i.seat));

  inspectorate.openDossier(CANDIDATE);
  inspectorate.record(CANDIDATE, concur(igs[0], CANDIDATE));
  inspectorate.record(CANDIDATE, concur(igs[1], CANDIDATE));

  const outcome = certifySovereign(inspectorate, CANDIDATE);
  assert.equal(outcome.certified, true);
  if (!outcome.certified) return;
  assert.equal(outcome.result.source, 'local-sovereign');
});

test('below quorum Apex refuses and does NOT look for another Inspectorate', () => {
  const inspectorate = new Inspectorate(DOC);
  inspectorate.seat(inspector('ig-a').seat);

  const outcome = certifySovereign(inspectorate, CANDIDATE);
  assert.equal(outcome.certified, false);
  if (outcome.certified) return;
  assert.equal(outcome.refused, 'below_quorum');
  assert.match(outcome.detail, /does NOT fall back/);
  assert.match(outcome.detail, /invert §13\.1/);
});

test('there is exactly one certification source, so a remote one cannot be added quietly', () => {
  const source = fs.readFileSync('server/constitution/sovereignty.ts', 'utf8');
  // The type has one member. A second would have to be added here, in a file
  // whose entire purpose is to say why it must not be.
  const matches = source.match(/export type CertificationSource = ([^;]+);/);
  assert.ok(matches, 'CertificationSource must be declared');
  assert.equal(matches![1].trim(), "'local-sovereign'");
});

test('certifySovereign cannot reach the network', () => {
  const source = fs.readFileSync('server/constitution/sovereignty.ts', 'utf8');
  for (const forbidden of ['fetch(', 'http://', 'https://', 'axios', 'request(']) {
    assert.ok(!source.includes(forbidden), `sovereignty.ts must not contain "${forbidden}"`);
  }
});

test('a certificate offered by an external party is refused, at any depth', () => {
  assert.equal(refuseForeignCertificate({ facts: [1, 2, 3] }).ok, true);

  const attacks: unknown[] = [
    { certificate: { serial: 'x' } },
    { execution: { record: { certificateOfRelease: {} } } },
    { a: { b: { c: { inspectorate: { seated: 3 } } } } },
    { releaseCertificate: 'trust me' },
  ];
  for (const attack of attacks) {
    const verdict = refuseForeignCertificate(attack);
    assert.equal(verdict.ok, false, `undetected: ${JSON.stringify(attack)}`);
    if (verdict.ok) continue;
    assert.match(verdict.reason, /may not send Apex permission/);
  }
});

// ===========================================================================
// External integration keys
// ===========================================================================

test('an issued key shows its plaintext once and stores only a hash', () => {
  const issued = issueKey({ tenantId: 't1', label: 'partner', scopes: ['inventory:read'] });
  assert.match(issued.plaintext, /^apex_[A-Za-z2-9]{12}_[A-Za-z2-9]{40}$/);

  const secret = issued.plaintext.split('_')[2];
  assert.equal(issued.record.secretHash, hashSecret(secret));
  assert.ok(!JSON.stringify(issued.record).includes(secret), 'the secret must not survive in the record');
});

test('a key with no scopes is refused at issue rather than at use', () => {
  assert.throws(() => issueKey({ tenantId: 't1', label: 'x', scopes: [] }), /at least one scope/);
});

test('there is no wildcard or admin scope', () => {
  for (const scope of SCOPES) {
    assert.ok(!scope.includes('*'), `"${scope}" is a wildcard`);
    assert.ok(!scope.startsWith('admin'), `"${scope}" is an admin scope`);
  }
});

test('scopes do not imply one another', async () => {
  const issued = issueKey({ tenantId: 't1', label: 'reader', scopes: ['inventory:read'] });
  const lookup = async () => issued.record;

  assert.equal((await verifyKey(issued.plaintext, lookup, ['inventory:read'])).ok, true);
  const escalation = await verifyKey(issued.plaintext, lookup, ['audit:read']);
  assert.equal(escalation.ok, false);
  if (escalation.ok) return;
  assert.equal(escalation.reason, 'insufficient_scope');
});

test('a revoked key stops working immediately', async () => {
  const issued = issueKey({ tenantId: 't1', label: 'x', scopes: ['twin:read'] });
  const revoked: ExternalKeyRecord = { ...issued.record, revokedAt: Date.now() };
  const result = await verifyKey(issued.plaintext, async () => revoked, ['twin:read']);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'revoked');
});

test('an expired key stops working', async () => {
  const issued = issueKey({ tenantId: 't1', label: 'x', scopes: ['twin:read'], expiresInDays: 1 });
  const later = Date.now() + 2 * 86_400_000;
  const result = await verifyKey(issued.plaintext, async () => issued.record, ['twin:read'], later);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'expired');
});

test('the wrong secret against a real key id is refused', async () => {
  const real = issueKey({ tenantId: 't1', label: 'x', scopes: ['twin:read'] });
  const forged = `apex_${real.record.keyId}_${'z'.repeat(40)}`;
  const result = await verifyKey(forged, async () => real.record, ['twin:read']);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'bad_secret');
});

test('malformed presentations are refused without a lookup', async () => {
  let looked = false;
  const lookup = async () => {
    looked = true;
    return undefined;
  };
  // Structurally wrong: no prefix, wrong prefix, wrong number of segments.
  // These are rejected by shape alone and must never cost a database round trip.
  for (const bad of [undefined, '', 'Bearer', 'nope', 'other_a_b', 'apex_missing_secret_extra']) {
    const result = await verifyKey(bad, lookup, []);
    assert.equal(result.ok, false);
    if (result.ok) continue;
    assert.equal(result.reason, 'malformed', `${bad} should be malformed`);
  }
  assert.equal(looked, false, 'a malformed key must not reach the database');

  // `apex_aaa_bbb` is NOT malformed — it is well-formed and unknown, which is a
  // different answer and must cost a lookup. Conflating the two would mean
  // either skipping lookups for real keys or querying on every scrap of junk.
  const unknown = await verifyKey('apex_aaa_bbb', lookup, []);
  assert.equal(looked, true, 'a well-formed key must be looked up');
  assert.equal(unknown.ok, false);
  if (unknown.ok) return;
  assert.equal(unknown.reason, 'unknown');
});

test('the Bearer prefix is optional but the format is not', async () => {
  const issued = issueKey({ tenantId: 't1', label: 'x', scopes: ['twin:read'] });
  assert.equal((await verifyKey(`Bearer ${issued.plaintext}`, async () => issued.record, ['twin:read'])).ok, true);
  assert.equal((await verifyKey(issued.plaintext, async () => issued.record, ['twin:read'])).ok, true);
  assert.deepEqual(parsePresented('apex_abc_def'), { keyId: 'abc', secret: 'def' });
});

test('rate limiting is per key, so one integration cannot starve another', () => {
  const limiter = new RateLimiter();
  const now = Date.now();
  for (let i = 0; i < 5; i += 1) {
    assert.equal(limiter.check('key-a', 5, now).allowed, true, `request ${i + 1} of 5`);
  }
  assert.equal(limiter.check('key-a', 5, now).allowed, false, 'the sixth exceeds the limit');
  assert.equal(limiter.check('key-b', 5, now).allowed, true, 'a different key is unaffected');

  // The window rolls.
  assert.equal(limiter.check('key-a', 5, now + 61_000).allowed, true);
});

// ===========================================================================
// The external surface
// ===========================================================================

test('every external route is read-only', () => {
  for (const route of EXTERNAL_ROUTES) {
    assert.equal(route.method, 'GET', `${route.path} is not a read`);
  }
});

test('every authenticated external route names exactly one scope', () => {
  for (const route of EXTERNAL_ROUTES) {
    if (route.path === '/api/v1') {
      assert.equal(route.scope, null, 'only the metadata route is unauthenticated');
      continue;
    }
    assert.ok(route.scope, `${route.path} has no scope`);
    assert.ok((SCOPES as readonly string[]).includes(route.scope!), `${route.path} names an unknown scope`);
  }
});

test('the external surface is separate from the ecosystem and console surfaces', () => {
  for (const route of EXTERNAL_ROUTES) {
    assert.ok(route.path.startsWith('/api/v1'), `${route.path} is outside the versioned namespace`);
    assert.ok(!route.path.startsWith('/api/ecosystem'), 'external and ecosystem surfaces must not overlap');
    assert.ok(!route.path.startsWith('/api/admin'), 'the external surface must never reach admin routes');
  }
});
