/**
 * Invite administration.
 *
 * Deliberately a CLI against the database rather than an HTTP endpoint.
 *
 * An invite-minting API is the highest-value target on a closed beta: whoever
 * reaches it can print themselves free accounts on a deployment with a real
 * inference budget. Guarding it with a role means the guard is one middleware
 * bug away from being nothing. Not having the endpoint at all means there is
 * no bug to find — you need shell access to the container, which is a
 * capability you already control.
 *
 * Usage (inside the running container, so it shares DATABASE_URL / DATA_DIR):
 *
 *   npm run invite -- mint --label "alex@example.com"
 *   npm run invite -- mint --count 5 --expires 14
 *   npm run invite -- list
 *   npm run invite -- revoke inv-1234…
 *   npm run invite -- usage
 *
 * The plaintext code is printed ONCE and never stored. Lose it and mint another.
 */

import crypto from 'crypto';
import { createStore, initialiseStore } from '../server/store';
import {
  currentPeriod,
  generateInviteCode,
  hashInviteCode,
  ratesFromEnv,
  type Invite,
} from '../server/store/beta';

const argv = process.argv.slice(2);
const command = argv[0] ?? 'help';

function flag(name: string, fallback?: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[index + 1] : fallback;
}

const HELP = `
Invite administration

  mint     Create invite codes. The plaintext is shown once and never stored.
             --label   <text>    who this is for, for your own records
             --count   <n>       how many to mint (default 1)
             --uses    <n>       redemptions per code (default 1)
             --expires <days>    expiry in days (default: never)

  list     Show every invite and its state.
  revoke   <id>  Permanently disable an invite.
  usage    Show this month's inference spend per tenant.
`;

async function main() {
  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(HELP);
    return;
  }

  const store = await createStore();
  await store.init();
  await initialiseStore(store);

  try {
    if (command === 'mint') {
      const count = Math.max(1, Number(flag('count', '1')));
      const maxUses = Math.max(1, Number(flag('uses', '1')));
      const days = Number(flag('expires', '0'));
      const label = flag('label') ?? null;
      const expiresAt =
        days > 0 ? new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString() : null;

      console.log(`\nMinted ${count} invite${count === 1 ? '' : 's'}. Copy these now — they are not recoverable.\n`);

      for (let i = 0; i < count; i++) {
        const code = generateInviteCode();
        const invite: Invite = {
          id: `inv-${crypto.randomUUID()}`,
          codeHash: hashInviteCode(code),
          label,
          createdAt: new Date().toISOString(),
          createdBy: process.env.USER ?? 'operator',
          maxUses,
          uses: 0,
          expiresAt,
          revokedAt: null,
          lastUsedAt: null,
          lastUsedBy: null,
        };
        await store.invites.create(invite);
        console.log(`  ${code}${label ? `   (${label})` : ''}`);
      }

      console.log(
        `\n  uses: ${maxUses} each · expires: ${expiresAt ? expiresAt.slice(0, 10) : 'never'}\n`,
      );
      return;
    }

    if (command === 'list') {
      const invites = await store.invites.list(500);
      if (invites.length === 0) {
        console.log('\nNo invites yet. Mint some with `npm run invite -- mint`.\n');
        return;
      }

      const now = new Date().toISOString();
      const state = (i: Invite) =>
        i.revokedAt
          ? 'revoked'
          : i.expiresAt && i.expiresAt <= now
            ? 'expired'
            : i.uses >= i.maxUses
              ? 'used'
              : 'open';

      console.log('');
      for (const invite of invites) {
        console.log(
          `  ${state(invite).padEnd(8)} ${invite.id}  ${invite.uses}/${invite.maxUses}  ` +
            `${(invite.label ?? '').padEnd(28)} ${invite.lastUsedBy ?? ''}`,
        );
      }
      console.log(`\n  ${await store.invites.countRedeemable()} redeemable right now.\n`);
      return;
    }

    if (command === 'revoke') {
      const id = argv[1];
      if (!id) {
        console.error('Usage: npm run invite -- revoke <id>');
        process.exitCode = 1;
        return;
      }
      const invite = await store.invites.revoke(id);
      console.log(invite ? `\nRevoked ${invite.id}.\n` : `\nNo invite with id ${id}.\n`);
      return;
    }

    if (command === 'usage') {
      const period = flag('period', currentPeriod())!;
      const rates = ratesFromEnv();
      const rows = await store.usage.list(period);

      console.log(`\nInference usage for ${period}`);
      if (!rates.configured) {
        console.log(
          '  WARNING: AI_INPUT_CENTS_PER_MTOK / AI_OUTPUT_CENTS_PER_MTOK are not set.\n' +
            '  Costs below use deliberately HIGH placeholder rates, so they over-state spend.\n' +
            "  Set them from your provider's current price list.",
        );
      }

      if (rows.length === 0) {
        console.log('  No model calls recorded this period.\n');
        return;
      }

      let total = 0;
      for (const row of rows) {
        total += row.costCents;
        const tenant = await store.tenants.get(row.tenantId as never);
        console.log(
          `  ${(tenant?.name ?? row.tenantId).padEnd(28)} ` +
            `${String(row.requests).padStart(5)} calls  ` +
            `${String(row.inputTokens + row.outputTokens).padStart(9)} tok  ` +
            `$${(row.costCents / 100).toFixed(4)}` +
            `${tenant ? `  of $${(tenant.monthlyAiCreditCents / 100).toFixed(2)}` : ''}`,
        );
      }
      console.log(`\n  Total: $${(total / 100).toFixed(4)}\n`);
      return;
    }

    console.log(HELP);
    process.exitCode = 1;
  } finally {
    await store.close();
  }
}

main().catch((err) => {
  console.error('invite:', err instanceof Error ? err.message : err);
  process.exit(1);
});
