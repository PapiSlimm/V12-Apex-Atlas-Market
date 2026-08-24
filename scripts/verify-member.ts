/**
 * Proves Apex Atlas is a MEMBER of the ecosystem, not just a target of it.
 *
 *   ORION_URL=http://localhost:4000 \
 *   ORION_PRIVATE_KEY=<apex's own key> \
 *   npx tsx scripts/verify-member.ts
 *
 * The point of these checks is the outbound direction. Apex answering a relay
 * was already covered by orion/scripts/verify-ecosystem.ts; what was missing —
 * while Apex was wrongly modelled as sitting outside the ecosystem — was its
 * ability to initiate at all.
 *
 * The last two checks matter most. Being a member does NOT mean being
 * unrestricted: an outbound call to a peer with no rule must still be refused,
 * and "permitted but unreachable" must look different from "not permitted".
 */

import { OrionClient, OrionError, orionClientConfigFromEnv } from '../server/orion-client';

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

async function main() {
  const config = orionClientConfigFromEnv();
  const client = new OrionClient(config);

  if (!client.enabled) {
    console.error('ORION_URL and ORION_PRIVATE_KEY are both required. Outbound is disabled.');
    process.exit(2);
  }

  console.log(`\nApex Atlas as ${config.appId} in realm ${config.realm}, via ${config.orionUrl}\n`);

  // --- it can initiate at all
  const ask = await client.ask("reconcile this month's royalty payouts");
  check('ask() — Apex initiates and the broker routes it', ask.routedTo === 'accounting', `${ask.routedTo} (${ask.confidence})`);

  const agent = await client.agent('legal', 'draft a distribution agreement');
  check('agent() — Apex addresses a named agent', agent.routedTo === 'legal', agent.agentName);

  // --- and it is still bounded
  // A peer Apex has a rule for, which is not running. The refusal must come
  // from the transport, NOT from authorisation — otherwise "your rule is
  // missing" and "the other app is down" are indistinguishable at 3am.
  try {
    await client.relay('nexion', '/api/ecosystem/ping');
    check('relay() to a permitted but offline peer', false, 'it somehow succeeded');
  } catch (err) {
    const kind = (err as OrionError).kind;
    check(
      'A permitted peer that is offline fails as unavailable, not forbidden',
      kind === 'unavailable' || kind === 'bad_request',
      kind,
    );
  }

  // A peer Apex has NO rule for. Membership is not permission.
  try {
    await client.relay('v12-multimedia', '/api/ecosystem/ping');
    check('An outbound call with no rule is refused', false, 'it was allowed');
  } catch (err) {
    check('An outbound call with no rule is refused', (err as OrionError).kind === 'forbidden', (err as OrionError).kind);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('verify-member failed:', err instanceof Error ? err.message : err);
  process.exit(2);
});
