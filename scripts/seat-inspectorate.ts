/**
 * Seat an Inspector General. A HUMAN act (Article XIII §13.5).
 *
 *   npm run constitution:seat -- keygen
 *   npm run constitution:seat -- add <id> "<name>" <publicKeyBase64>
 *   npm run constitution:seat -- list
 *
 * `keygen` prints a keypair and then FORGETS the private half. That half
 * belongs to a person, stored where the ecosystem cannot reach it — because the
 * whole force of Article XIII is that this system cannot manufacture a
 * concurrence. If the private key lives on the same host as the app, it can.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { InspectorGeneral } from '../server/constitution/types';

const FILE = path.resolve(process.cwd(), 'constitution', 'inspectorate.json');
const [command, ...args] = process.argv.slice(2);

const read = (): { inspectors: InspectorGeneral[] } =>
  fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : { inspectors: [] };

if (command === 'keygen') {
  const keys = crypto.generateKeyPairSync('ed25519');
  console.log('PUBLIC  (goes in the seat register, safe to commit)');
  console.log(`  ${keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')}\n`);
  console.log('PRIVATE (shown once — give it to the PERSON, never to a server)');
  console.log(`  ${keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')}\n`);
  console.log('If this private key ends up on the same host as the application,');
  console.log('the application can certify itself and Article XIII is decorative.');
} else if (command === 'add') {
  const [id, name, publicKey] = args;
  if (!id || !name || !publicKey) {
    console.error('usage: add <id> "<name>" <publicKeyBase64>');
    process.exit(2);
  }
  if (publicKey.includes('MC4CAQAwBQYDK2Vw')) {
    console.error('That is a PRIVATE key. A seat holds the public half only (§13.5).');
    process.exit(2);
  }
  const register = read();
  register.inspectors = register.inspectors.filter((i) => i.id !== id);
  register.inspectors.push({ id, name, kind: 'human', publicKey, seatedAt: Date.now() });
  fs.writeFileSync(FILE, `${JSON.stringify(register, null, 2)}\n`);
  console.log(`Seated ${id}. ${register.inspectors.length} seated; 3 required for quorum.`);
  if (register.inspectors.length < 3) console.log('Below quorum — every release is still refused (§13.4).');
} else {
  const register = read();
  console.log(`${register.inspectors.length} seated (3 required)\n`);
  for (const i of register.inspectors) {
    const fingerprint = crypto.createHash('sha256').update(i.publicKey).digest('hex').slice(0, 16);
    console.log(`  ${i.id.padEnd(16)} ${i.name.padEnd(24)} ${fingerprint}`);
  }
}
