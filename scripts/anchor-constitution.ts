/**
 * Re-anchor the Constitution. A HUMAN ACT, with a reviewable diff.
 *
 *   npm run constitution:anchor
 *
 * This is the only supported way to make an edited constitution.yaml loadable.
 * There is deliberately no flag that lets a service skip verification instead.
 */
import { anchor, verifyAnchor } from '../server/constitution/anchor';

const { digest } = anchor();
const result = verifyAnchor();
console.log(`Anchored ${result.document.instrument} v${result.ratification}`);
console.log(`SHA-256  ${digest}`);
console.log('\nCommit constitution.lock alongside constitution.yaml. A service that');
console.log('sees one without the other refuses to start, by design.');
