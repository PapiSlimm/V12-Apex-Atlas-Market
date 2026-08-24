/**
 * Deployment shape.
 *
 * These tests read build files rather than code, which is unusual and earns its
 * place: the runtime image is assembled by a Dockerfile that copies a hand-
 * written list of paths, and the application resolves its constitution from the
 * working directory at boot. A missing COPY line therefore produces an image
 * that builds cleanly, passes every other test in this suite, and then refuses
 * to start in production with a message about a missing anchor.
 *
 * That is the constitution behaving exactly as designed (Article I §1.3 — no
 * degraded start, no bypass flag) and a miserable way to find out about a typo.
 * So the deployment manifest is asserted here, where it costs milliseconds.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file: string): string => fs.readFileSync(path.join(root, file), 'utf8');

const dockerfile = read('Dockerfile');
/** Everything after the runtime stage begins. The build stage copies the world. */
const runtimeStage = dockerfile.slice(dockerfile.indexOf('AS runtime'));

test('the runtime image carries the constitution the process refuses to start without', () => {
  for (const file of ['constitution.yaml', 'constitution.lock', 'inspectorate.json']) {
    assert.match(
      runtimeStage,
      new RegExp(`COPY[^\\n]*constitution/${file.replace('.', '\\.')}`),
      `the runtime stage does not copy constitution/${file} — the image will fail closed on first boot`,
    );
  }
});

test('the constitution is read-only in the image', () => {
  const copies = runtimeStage.split('\n').filter((l) => l.includes('constitution/'));
  assert.ok(copies.length >= 3);
  for (const line of copies) {
    assert.match(line, /--chmod=444/, `${line.trim()} is writable — a process must not be able to re-anchor itself`);
    assert.match(line, /--chown=root:root/, 'the unprivileged runtime user must not own its own constitution');
  }
});

test('the runtime image does not run as root', () => {
  assert.match(runtimeStage, /^USER node$/m);
});

test('the healthcheck verifies the audit chain, not just the port', () => {
  assert.match(dockerfile, /HEALTHCHECK/);
  assert.match(dockerfile, /\/api\/health/);
  assert.match(dockerfile, /status==='ok'/, 'a healthcheck that ignores the body cannot notice a broken chain');
});

test('the dockerignore does not exclude the constitution', () => {
  const ignored = read('.dockerignore').split('\n').map((l) => l.trim()).filter(Boolean);
  assert.equal(
    ignored.some((line) => line === 'constitution' || line === 'constitution/'),
    false,
    'excluding it here would defeat the COPY that depends on it',
  );
});

test('the Render blueprint carries no secrets', () => {
  const blueprint = read('render.yaml');
  const secretish = /^\s*-?\s*key:\s*(JWT_SECRET|GEMINI_API_KEY|ORION_PRIVATE_KEY|ADMIN_API_TOKEN|DATABASE_URL)\s*$/gm;
  const keys = [...blueprint.matchAll(secretish)].map((m) => m[1]);

  for (const key of keys) {
    const block = blueprint.slice(blueprint.indexOf(`key: ${key}`));
    const nextTwoLines = block.split('\n').slice(1, 3).join('\n');
    assert.match(
      nextTwoLines,
      /(sync:\s*false|generateValue:\s*true|fromDatabase:)/,
      `${key} is not marked sync:false, generateValue or fromDatabase — a blueprint that carries a secret leaks it`,
    );
  }
});

test('the Render blueprint runs on Postgres, which the Constitution requires in production', () => {
  const blueprint = read('render.yaml');
  assert.match(blueprint, /fromDatabase:/, 'Article II §2.1 — SQLite cannot provide row-level tenant isolation');
  assert.match(blueprint, /NODE_ENV[\s\S]{0,40}production/);
  // Matched as a KEY, not as a string: the blueprint discusses both of these in
  // its "deliberately absent" comment, and a test that cannot tell a comment
  // from a setting would force the explanation to be deleted to stay green.
  assert.doesNotMatch(
    blueprint,
    /^\s*-?\s*key:\s*ENABLE_DEMO_USERS/m,
    'seeded credentials in a live deployment become breaches',
  );
  assert.doesNotMatch(blueprint, /^\s*-?\s*key:\s*ADMIN_API_TOKEN/m, 'unset means the invite-minting API is not mounted at all');
});

test('the constitution in the repo is anchored to its lock', () => {
  const lock = read('constitution/constitution.lock').trim().split(/\s+/)[0];
  assert.match(lock, /^[0-9a-f]{64}$/, 'the lock must be a bare SHA-256 digest, matching the estate format');
});

test('three Inspector General seats are filled, and only public halves are stored', () => {
  const register = JSON.parse(read('constitution/inspectorate.json')) as {
    inspectors: { id: string; name: string; kind: string; publicKey: string }[];
  };
  assert.ok(register.inspectors.length >= 3, 'below quorum every Certificate of Release is refused (§13.4)');

  for (const inspector of register.inspectors) {
    assert.equal(inspector.kind, 'human', 'an agent cannot hold a seat');
    // PKCS8 Ed25519 private keys begin MC4CAQAwBQYDK2Vw. If one is ever in this
    // file, the application can certify itself and Article XIII is decoration.
    assert.doesNotMatch(inspector.publicKey, /^MC4CAQAwBQYDK2Vw/, `${inspector.id} holds a PRIVATE key`);
    assert.match(inspector.publicKey, /^MCowBQYDK2VwAyEA/, `${inspector.id}'s key is not an Ed25519 public key`);
  }

  const fingerprints = new Set(register.inspectors.map((i) => i.publicKey));
  assert.equal(fingerprints.size, register.inspectors.length, 'two seats sharing a key is one person holding two votes');
});
