import test from 'node:test';
import assert from 'node:assert/strict';
import { assessAdmission, renderDossier, isEntrenched, ENTRENCHED, type AdmissionCandidate } from '../server/atlas/admission';
import { AETHER, AETHER_APPOINTMENT } from '../server/atlas/aether';

const clean: AdmissionCandidate = { appId: 'x', name: 'X', services: [], resources: [], findings: [] };

test('the entrenched set is exactly Article XII §12.4', () => {
  assert.deepEqual([...ENTRENCHED].sort(), ['I', 'II', 'III', 'VII', 'X', 'XII', 'XIII']);
  assert.equal(isEntrenched('III'), true);
  assert.equal(isEntrenched('V'), false);
});

test('a clean candidate is admitted', () => {
  const decision = assessAdmission(clean);
  assert.equal(decision.verdict, 'ADMITTED');
});

test('non-entrenched findings become conditions, not a refusal', () => {
  const decision = assessAdmission({
    ...clean,
    findings: [{ article: 'V', section: '§5.1', observed: 'o', evidence: 'e', remedy: 'r' }],
  });
  assert.equal(decision.verdict, 'ADMITTED_WITH_CONDITIONS');
  assert.equal(decision.conditions.length, 1);
});

test('a single entrenched finding refuses, whatever else is true', () => {
  const decision = assessAdmission({
    ...clean,
    findings: [{ article: 'III', section: '§3.3', observed: 'o', evidence: 'e', remedy: 'r' }],
  });
  assert.equal(decision.verdict, 'REFUSED');
  assert.match(decision.reason, /no conditional admission is available/);
});

test('there is no conditional admission for an entrenched violation', () => {
  // Many conditions plus one entrenched finding must not average out to admitted.
  const decision = assessAdmission({
    ...clean,
    findings: [
      { article: 'V', section: '§5.1', observed: 'o', evidence: 'e', remedy: 'r' },
      { article: 'IV', section: '§4.1', observed: 'o', evidence: 'e', remedy: 'r' },
      { article: 'II', section: '§2.1', observed: 'o', evidence: 'e', remedy: 'r' },
    ],
  });
  assert.equal(decision.verdict, 'REFUSED');
});

test('an Apex refusal is never appealable', () => {
  for (const findings of [[], [{ article: 'III' as const, section: '§3.1', observed: 'o', evidence: 'e', remedy: 'r' }]]) {
    assert.equal(assessAdmission({ ...clean, findings }).appealable, false);
  }
});

test('refusal is not exile — an interim path is always stated', () => {
  const decision = assessAdmission({
    ...clean,
    findings: [{ article: 'III', section: '§3.3', observed: 'o', evidence: 'e', remedy: 'r' }],
  });
  assert.match(decision.interim, /retained locally/);
  assert.match(decision.interim, /commingles nothing/);
});

// ---------------------------------------------------------------- Aether

test('Aether is refused, on entrenched Articles', () => {
  const decision = assessAdmission(AETHER);
  assert.equal(decision.verdict, 'REFUSED');
  const articles = new Set(decision.blocking.map((f) => f.article));
  assert.ok(articles.has('III'), 'money determinism');
  assert.ok(articles.has('II'), 'tenant sovereignty');
  assert.ok(articles.has('VII'), 'classification at ingress');
});

test('every Aether finding cites checkable evidence and a remedy', () => {
  for (const f of AETHER.findings) {
    assert.ok(f.evidence.length > 20, `${f.article} ${f.section} has no real evidence`);
    assert.ok(f.remedy.length > 20, `${f.article} ${f.section} has no remedy`);
    assert.match(f.evidence, /\.ts|schema|server/, `${f.article} ${f.section} does not point at a file`);
  }
});

test('the deletable ledger is recorded as a blocking finding', () => {
  const decision = assessAdmission(AETHER);
  const ledger = decision.blocking.find((f) => f.section === '§3.3');
  assert.ok(ledger, 'the ledger wipe must block admission');
  assert.match(ledger!.evidence, /ledger\/wipe/);
});

test('Aether is appointed under Apex, not into the v12 ecosystem', () => {
  assert.equal(AETHER_APPOINTMENT.governedBy, 'V12 Apex Atlas');
  assert.equal(AETHER_APPOINTMENT.realm, 'apex-galaxy');
  assert.notEqual(AETHER_APPOINTMENT.realm, 'v12-ecosystem');
});

test('the appointment grants read-only scopes and withholds the sensitive ones', () => {
  for (const scope of AETHER_APPOINTMENT.externalScopes) {
    assert.match(scope, /:read$/, `${scope} is not read-only`);
  }
  assert.ok(AETHER_APPOINTMENT.withheldScopes.includes('audit:read'));
  assert.ok(AETHER_APPOINTMENT.withheldScopes.includes('twin:read'));
  const overlap = AETHER_APPOINTMENT.externalScopes.filter((s) =>
    (AETHER_APPOINTMENT.withheldScopes as readonly string[]).includes(s),
  );
  assert.equal(overlap.length, 0, 'a scope cannot be both granted and withheld');
});

test('the dossier renders the verdict, the blockers and the interim path', () => {
  const dossier = renderDossier(AETHER, assessAdmission(AETHER));
  assert.match(dossier, /VERDICT   REFUSED/);
  assert.match(dossier, /Article IX §9\.3/);
  assert.match(dossier, /BLOCKING/);
  assert.match(dossier, /IN THE MEANTIME/);
});

// ---------------------------------------------------------- One-Click Purge

test('One-Click Data Purge is refused', async () => {
  const { ONE_CLICK_PURGE } = await import('../server/atlas/one-click-purge');
  const decision = assessAdmission(ONE_CLICK_PURGE);
  assert.equal(decision.verdict, 'REFUSED');
});

test('the simulated revocation and purge are recorded as harm to the person', async () => {
  const { ONE_CLICK_PURGE } = await import('../server/atlas/one-click-purge');
  const harmful = ONE_CLICK_PURGE.findings.filter((f) => f.subjectHarm);
  assert.ok(harmful.length >= 2, 'both simulated controls must be flagged');

  const revocation = harmful.find((f) => f.observed.includes('Token revocation is simulated'));
  assert.ok(revocation, 'the fake revocation must be flagged as harmful');
  assert.match(revocation!.subjectHarm!, /remains fully live/);

  const purge = harmful.find((f) => f.observed.includes('Erasure requests are simulated'));
  assert.ok(purge, 'the fake purge must be flagged as harmful');
});

test('harm to the person is rendered before the Article list', async () => {
  const { ONE_CLICK_PURGE } = await import('../server/atlas/one-click-purge');
  const dossier = renderDossier(ONE_CLICK_PURGE, assessAdmission(ONE_CLICK_PURGE));
  assert.match(dossier, /HARM TO THE PERSON — read this first/);
  assert.ok(
    dossier.indexOf('HARM TO THE PERSON') < dossier.indexOf('BLOCKING'),
    'a reader must meet the harm before the compliance list',
  );
});

test('a privacy tool is admitted with no scopes at all', async () => {
  const { ONE_CLICK_APPOINTMENT } = await import('../server/atlas/one-click-purge');
  assert.equal(ONE_CLICK_APPOINTMENT.externalScopes.length, 0);
  assert.ok(ONE_CLICK_APPOINTMENT.withheldScopes.includes('audit:read'));
  assert.equal(ONE_CLICK_APPOINTMENT.realm, 'apex-galaxy');
});

test('a candidate with no harm findings renders no harm section', () => {
  const dossier = renderDossier(
    { appId: 'x', name: 'X', services: [], resources: [], findings: [] },
    assessAdmission({ appId: 'x', name: 'X', services: [], resources: [], findings: [] }),
  );
  assert.ok(!dossier.includes('HARM TO THE PERSON'));
});
