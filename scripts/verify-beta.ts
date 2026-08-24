/**
 * Closed-beta gate probe, over HTTP against a running deployment.
 *
 * The unit tests prove the store's invite logic is correct. This proves the
 * deployment is actually *wired* to it — that `INVITE_ONLY` is set, that the
 * cap is enforced, and that a stranger with no code is refused. Those are
 * configuration facts, and configuration is what gets forgotten on the day of
 * a launch.
 *
 * Run against a deployment you are willing to create accounts on:
 *   npm run verify:beta http://localhost:3000
 *
 * Exit codes: 0 clean, 1 a check failed, 2 unreachable.
 */

import crypto from 'crypto';
import { createStore, initialiseStore } from '../server/store';
import { generateInviteCode, hashInviteCode, type Invite } from '../server/store/beta';

const BASE = process.argv[2] || 'http://localhost:3000';

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const rand = () => crypto.randomBytes(4).toString('hex');

async function register(body: Record<string, unknown>) {
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as { code?: string; error?: string } };
}

async function main() {
  let health: any;
  try {
    health = await fetch(`${BASE}/api/health`).then((r) => r.json());
  } catch (err) {
    console.error(`Cannot reach ${BASE}/api/health — ${err instanceof Error ? err.message : err}`);
    process.exit(2);
  }

  console.log(
    `\nProbing ${BASE} — inviteOnly=${health.beta?.inviteOnly} cap=${health.beta?.maxTenants ?? 'none'} ` +
      `tenants=${health.tenants} redeemable=${health.beta?.redeemableInvites}\n`,
  );

  check('The deployment reports invite-only registration', health.beta?.inviteOnly === true);
  check('A population cap is configured', Boolean(health.beta?.maxTenants), String(health.beta?.maxTenants));

  /*
   * A deployment already at capacity cannot exercise the acceptance path, and
   * running those checks anyway produces a screen of FAILs that mean "the beta
   * is full" rather than "the gate is broken" — the worst kind of red, because
   * it teaches an operator to ignore the probe. So it is detected and reported
   * as the precondition it is.
   */
  const atCapacity = health.beta?.maxTenants ? health.beta.headroom === 0 : false;
  if (atCapacity) {
    console.log(
      '\nSKIP  The beta is at capacity, so the acceptance path cannot be probed.\n' +
        '      Raise BETA_MAX_TENANTS or run against a fresh deployment to exercise it.\n',
    );
  }

  // --- a stranger with no code ---------------------------------------------
  const noCode = await register({
    email: `stranger-${rand()}@example.com`,
    password: 'a-very-long-password',
    name: 'Uninvited Stranger',
  });
  check(
    'A stranger with no invite code is refused',
    noCode.status === 403 && (atCapacity ? true : noCode.body.code === 'invite_required'),
    `status ${noCode.status} ${noCode.body.code ?? ''}`,
  );

  // --- a stranger guessing -------------------------------------------------
  const guessed = await register({
    email: `guesser-${rand()}@example.com`,
    password: 'a-very-long-password',
    name: 'Optimistic Guesser',
    invite: generateInviteCode(),
  });
  check(
    'An invented code is refused',
    guessed.status === 403 && (atCapacity ? true : guessed.body.code === 'invite_invalid'),
    `status ${guessed.status} ${guessed.body.code ?? ''}`,
  );
  if (!atCapacity) {
    check(
      'The refusal does not reveal whether the code ever existed',
      guessed.body.error === 'That invite code is not valid.',
      guessed.body.error ?? '',
    );
  }

  // --- a real invite --------------------------------------------------------
  // Minted directly against the store, exactly as `npm run invite` does, because
  // there is deliberately no HTTP endpoint that mints codes.
  const store = await createStore();
  await store.init();
  await initialiseStore(store);

  try {
    const code = generateInviteCode();
    const invite: Invite = {
      id: `inv-probe-${crypto.randomUUID()}`,
      codeHash: hashInviteCode(code),
      label: 'verify-beta probe',
      createdAt: new Date().toISOString(),
      createdBy: 'verify-beta',
      maxUses: 1,
      uses: 0,
      expiresAt: null,
      revokedAt: null,
      lastUsedAt: null,
      lastUsedBy: null,
    };
    await store.invites.create(invite);

    const email = `invited-${rand()}@example.com`;
    const accepted = atCapacity
      ? { status: 0, body: {} as { code?: string } }
      : await register({
      email,
      password: 'a-very-long-password',
      name: 'Invited Tester',
      organisation: `Probe ${rand()}`,
          invite: code,
        });

    if (!atCapacity) {
      check('A valid invite is accepted', accepted.status === 201, `status ${accepted.status}`);

      // --- the same code, twice ----------------------------------------------
      const reused = await register({
        email: `reuse-${rand()}@example.com`,
        password: 'a-very-long-password',
        name: 'Code Sharer',
        invite: code,
      });
      check(
        'A single-use code cannot be shared',
        reused.status === 403 && reused.body.code === 'invite_invalid',
        `status ${reused.status} ${reused.body.code ?? ''}`,
      );

      // --- the audit trail ---------------------------------------------------
      const stored = (await store.invites.list(500)).find((i) => i.id === invite.id);
      check(
        'The redemption is traceable to the account it created',
        stored?.lastUsedBy === email,
        stored?.lastUsedBy ?? '',
      );
    }

    // --- the cap -------------------------------------------------------------
    const after = await fetch(`${BASE}/api/health`).then((r) => r.json());
    const cap = after.beta?.maxTenants;
    if (cap) {
      if (!atCapacity) {
        check(
          'Headroom decreases as accounts are created',
          after.beta.headroom < health.beta.headroom,
          `${health.beta.headroom} -> ${after.beta.headroom}`,
        );
      }

      if (after.beta.headroom === 0) {
        // A spare, valid code, offered while the beta is full. Both things must
        // hold: the signup is refused, AND the code survives. The first version
        // of the server redeemed before checking the cap, which burned a real
        // person's invite and then told them it was still valid.
        const spareCode = generateInviteCode();
        const spare: Invite = {
          id: `inv-probe-${crypto.randomUUID()}`,
          codeHash: hashInviteCode(spareCode),
          label: 'verify-beta capacity probe',
          createdAt: new Date().toISOString(),
          createdBy: 'verify-beta',
          maxUses: 1,
          uses: 0,
          expiresAt: null,
          revokedAt: null,
          lastUsedAt: null,
          lastUsedBy: null,
        };
        await store.invites.create(spare);

        const capped = await register({
          email: `overflow-${rand()}@example.com`,
          password: 'a-very-long-password',
          name: 'One Too Many',
          organisation: `Overflow ${rand()}`,
          invite: spareCode,
        });
        check(
          'Registration is refused at the cap even with a valid code',
          capped.status === 403 && capped.body.code === 'beta_at_capacity',
          `status ${capped.status} ${capped.body.code ?? ''}`,
        );

        const afterRefusal = (await store.invites.list(500)).find((i) => i.id === spare.id);
        check(
          'A refused signup does not burn the invite',
          afterRefusal?.uses === 0,
          `uses ${afterRefusal?.uses}`,
        );
      } else {
        console.log(
          `INFO  Cap not reached (${after.beta.headroom} remaining), so the at-capacity refusal was not exercised.`,
        );
      }
    }
  } finally {
    await store.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('verify-beta failed:', err instanceof Error ? err.message : err);
  process.exit(2);
});
