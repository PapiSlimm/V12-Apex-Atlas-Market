/**
 * External integration key administration.
 *
 * A CLI against the database, for the same reason invites are: an endpoint that
 * mints credentials for the outside world is the highest-value target on the
 * whole deployment, and the safest guard on an endpoint is not having one. This
 * needs shell access to the container, which is a capability you already
 * control and can already revoke.
 *
 *   npm run key -- issue --tenant tnt-… --label "Partner ERP" --scopes inventory:read,twin:read
 *   npm run key -- issue --label "Partner ERP" --scopes audit:read --expires 30 --rate 120
 *   npm run key -- list
 *   npm run key -- list --tenant tnt-…
 *   npm run key -- revoke <keyId>
 *   npm run key -- routes
 *
 * The plaintext key is printed ONCE. Apex stores only a SHA-256 of the secret
 * half and genuinely cannot recover it — which is the correct answer when an
 * integrator asks for their key back, and the reason this prints a warning
 * rather than an offer to look it up.
 */

import { createStore, initialiseStore } from '../server/store';
import { DEFAULT_TENANT_ID } from '../server/store/tenancy';
import { EXTERNAL_ROUTES } from '../server/external/router';
import { SCOPES, isScope, issueKey, type Scope } from '../server/external/keys';

const argv = process.argv.slice(2);
const command = argv[0] ?? 'help';

function flag(name: string, fallback?: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[index + 1] : fallback;
}

const HELP = `
External integration keys

  issue    Mint a key. The plaintext is shown once and never stored.
             --tenant   Tenant id (default: ${DEFAULT_TENANT_ID})
             --label    Who this key is for. Required — an unlabelled key is unrevocable in practice.
             --scopes   Comma-separated. Available: ${SCOPES.join(', ')}
             --expires  Days until it lapses (default 90; "never" for no expiry, discouraged)
             --rate     Requests per minute (default 60)

  list     Show issued keys. Never shows a secret, because none is stored.
             --tenant   Restrict to one tenant

  revoke   Revoke a key by its id. Immediate, one-way, effective on the next request.

  routes   Print the complete surface an external key can reach.
`;

async function main(): Promise<void> {
  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(HELP);
    return;
  }

  if (command === 'routes') {
    console.log('\nEverything a valid external key can reach:\n');
    for (const route of EXTERNAL_ROUTES) {
      console.log(`  ${route.method.padEnd(5)} ${route.path.padEnd(22)} ${(route.scope ?? '(public)').padEnd(18)} ${route.description}`);
    }
    console.log('\nEvery route is read-only. There is no external write path.\n');
    return;
  }

  const store = await createStore();
  await initialiseStore(store);

  try {
    if (command === 'issue') {
      const label = flag('label');
      if (!label) throw new Error('--label is required. An unlabelled key cannot be revoked with confidence later.');

      const raw = (flag('scopes') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      if (raw.length === 0) throw new Error(`--scopes is required. Available: ${SCOPES.join(', ')}`);
      for (const scope of raw) {
        if (!isScope(scope)) throw new Error(`Unknown scope "${scope}". Available: ${SCOPES.join(', ')}`);
      }

      const expiresRaw = flag('expires', '90');
      const expiresInDays = expiresRaw === 'never' ? null : Number(expiresRaw);
      if (expiresInDays !== null && (!Number.isFinite(expiresInDays) || expiresInDays <= 0)) {
        throw new Error('--expires must be a positive number of days, or "never".');
      }

      const issued = issueKey({
        tenantId: flag('tenant', DEFAULT_TENANT_ID)!,
        label,
        scopes: raw as Scope[],
        expiresInDays,
        ratePerMinute: Number(flag('rate', '60')),
      });

      await store.externalKeys.save(issued.record);

      console.log('\n  Key issued.\n');
      console.log(`  id        ${issued.record.keyId}`);
      console.log(`  label     ${issued.record.label}`);
      console.log(`  tenant    ${issued.record.tenantId}`);
      console.log(`  scopes    ${issued.record.scopes.join(', ')}`);
      console.log(`  expires   ${issued.record.expiresAt ? new Date(issued.record.expiresAt).toISOString() : 'never (discouraged)'}`);
      console.log(`  rate      ${issued.record.ratePerMinute}/min\n`);
      console.log(`  ${issued.plaintext}\n`);
      console.log('  This is the only time that value exists. Apex stores a hash of the secret half');
      console.log('  and cannot recover it. If it is lost, revoke this key and issue another.\n');
      return;
    }

    if (command === 'list') {
      const tenant = flag('tenant', DEFAULT_TENANT_ID)!;
      const keys = await store.externalKeys.listFor(tenant as never);
      if (keys.length === 0) {
        console.log(`\n  No external keys issued for ${tenant}.\n`);
        return;
      }
      console.log(`\n  ${keys.length} key(s) for ${tenant}:\n`);
      for (const k of keys) {
        const state = k.revokedAt
          ? `REVOKED ${new Date(k.revokedAt).toISOString()}`
          : k.expiresAt && Date.now() > k.expiresAt
            ? 'EXPIRED'
            : 'active';
        console.log(`  ${k.keyId}  ${state.padEnd(34)} ${k.label}`);
        console.log(`  ${' '.repeat(k.keyId.length)}  ${k.scopes.join(', ')}\n`);
      }
      return;
    }

    if (command === 'revoke') {
      const keyId = argv[1];
      if (!keyId) throw new Error('Usage: npm run key -- revoke <keyId>');
      const rows = await store.externalKeys.revoke(keyId, Date.now());
      console.log(
        rows === 1
          ? `\n  ${keyId} revoked. It stops working on its next request.\n`
          : `\n  Nothing to do — ${keyId} is unknown or already revoked.\n`,
      );
      return;
    }

    console.log(HELP);
  } finally {
    await store.close();
  }
}

main().catch((err) => {
  console.error(`\n  ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
