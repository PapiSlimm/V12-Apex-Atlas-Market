/**
 * Live probe against Orion Prime.
 *
 *   ORION_PRIME_URL=https://orion-prime-wkvl.onrender.com npm run orion:check
 *
 * Separate from `preflight` on purpose. Orion Prime being down is not a reason
 * to block an Apex deployment — Apex does not depend on it — so this is a tool
 * you run, not a gate that runs you.
 */

import { checkOrionPrime, orionPrimeConfigFromEnv } from '../server/orion-prime';

async function main() {
  const config = orionPrimeConfigFromEnv();

  if (!config.baseUrl) {
    console.error('ORION_PRIME_URL is not set (or was refused as unsafe). Nothing to check.');
    process.exit(2);
  }

  console.log(`Probing ${config.baseUrl}/api/health …\n`);
  const status = await checkOrionPrime(config);

  if (status.state === 'online') {
    console.log(`ONLINE      ${status.health.system}`);
    console.log(`version     ${status.health.version}`);
    console.log(`status      ${status.health.status}`);
    console.log(`aiConnected ${status.health.aiConnected}`);
    console.log(`latency     ${status.latencyMs}ms`);
    console.log(`\nReachable. This proves liveness and nothing else — it is an`);
    console.log(`unauthenticated read of a public endpoint. No integration is`);
    console.log(`wired until Orion Prime's route list and credential model are known.`);
    process.exit(0);
  }

  if (status.state === 'unreachable') {
    console.log(`UNREACHABLE  ${status.reason}  (${status.latencyMs}ms)`);
    if (status.reason === 'not_json') {
      console.log(`\nThe host answered 200 with something that is not JSON — almost`);
      console.log(`certainly the console's own HTML from the single-page-app`);
      console.log(`catch-all. That means /api/health did not handle this request.`);
    }
    if (status.reason === 'timeout') {
      console.log(`\nRender free-tier services sleep after inactivity and can take`);
      console.log(`~50s to wake. Try once more before believing this.`);
    }
    process.exit(1);
  }

  console.log('DISABLED');
  process.exit(2);
}

main().catch((err) => {
  // checkOrionPrime does not throw; reaching here means something else did.
  console.error('check-orion-prime failed unexpectedly:', err instanceof Error ? err.message : err);
  process.exit(2);
});
