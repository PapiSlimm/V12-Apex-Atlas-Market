/**
 * Design system tests — the parts that are logic rather than pixels.
 *
 * Formatting and status mapping are exactly the code that silently disagrees
 * between screens when it is copy-pasted, and exactly the code that is cheap to
 * pin down. Rendering is checked in the browser suite, where a real DOM exists.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { compact, count, percent, signedUsd, usd } from '../src/design/format';
import { DEFAULT_LABEL, STATUS_STYLE, roleFor, type StatusRole } from '../src/design/status';

test('Compact number formatting', async (t) => {
  await t.test('leaves readable numbers alone', () => {
    // "1.3K" is strictly less informative than "1,284" and saves three
    // characters. Compaction has to earn its place.
    assert.equal(compact(1284), '1,284');
    assert.equal(compact(9999), '9,999');
    assert.equal(compact(0), '0');
  });

  await t.test('compacts once the full number stops being scannable', () => {
    assert.equal(compact(12900), '12.9K');
    assert.equal(compact(4_200_000), '4.2M');
    assert.equal(compact(1_500_000_000), '1.5B');
  });

  await t.test('keeps the decimal that carries information, drops the one that does not', () => {
    assert.equal(compact(12_000_000), '12M', 'a bare .0 is noise');
    assert.equal(compact(9_900_000), '9.9M');
    assert.equal(compact(12_900), '12.9K');
  });

  await t.test('carries the sign and the currency prefix', () => {
    assert.equal(compact(-4_200_000, true), '-$4.2M');
    assert.equal(compact(73856, true), '$73.9K');
  });

  await t.test('a non-finite value is an em dash, never NaN on screen', () => {
    assert.equal(compact(NaN), '—');
    assert.equal(compact(Infinity), '—');
    assert.equal(usd(NaN), '—');
    assert.equal(count(NaN), '—');
  });
});

test('Currency and percentage formatting', async (t) => {
  await t.test('usd keeps full precision for figures that must reconcile', () => {
    assert.equal(usd(12.5), '$12.50');
    assert.equal(usd(73856), '$73,856.00');
  });

  await t.test('a leading plus is information, not decoration', () => {
    assert.equal(signedUsd(5329.6), '+$5,329.60');
    assert.equal(signedUsd(-10.85), '-$10.85');
  });

  await t.test('null is not zero', () => {
    // A meter reading "0%" because a field is missing looks healthy. That is
    // the most dangerous way to be missing data, so it must read as unknown.
    assert.equal(percent(null), '—');
    assert.equal(percent(undefined), '—');
    assert.equal(percent(0), '0.0%');
    assert.equal(percent(0.4203), '42.0%');
  });
});

test('Status vocabulary', async (t) => {
  await t.test('maps every term the application actually emits', () => {
    const cases: [string, StatusRole][] = [
      ['operational', 'good'],
      ['degraded', 'warning'],
      ['offline', 'critical'],
      ['SELL_STRIKE', 'good'],
      ['SELL_STOP_LOSS', 'critical'],
      ['HOLD_UNECONOMIC', 'warning'],
      ['HOLD', 'neutral'],
      ['filled', 'good'],
      ['rejected', 'critical'],
      ['refused', 'critical'],
      ['allowed', 'good'],
    ];
    for (const [term, expected] of cases) {
      assert.equal(roleFor(term), expected, `${term} should map to ${expected}`);
    }
  });

  await t.test('an unknown state renders as unknown rather than throwing', () => {
    assert.equal(roleFor('something_new'), 'neutral');
    assert.equal(roleFor(null), 'neutral');
    assert.equal(roleFor(undefined), 'neutral');
    assert.equal(roleFor(''), 'neutral');
  });

  await t.test('every role has a style and a fallback word', () => {
    // A chip must never render as a bare colour — colour alone carries no
    // meaning in greyscale, under forced-colors, or for a colourblind reader.
    for (const role of Object.keys(STATUS_STYLE) as StatusRole[]) {
      assert.ok(STATUS_STYLE[role].ink, `${role} needs an ink colour`);
      assert.ok(STATUS_STYLE[role].mark, `${role} needs a mark colour`);
      assert.ok(DEFAULT_LABEL[role], `${role} needs a fallback label`);
    }
  });

  await t.test('status roles are disjoint from the categorical series', () => {
    // A status colour must never impersonate a data series. The series slots
    // are var(--series-N); only the reserved `info` role borrows one, and it
    // does so deliberately for neutral informational chips.
    const seriesBacked = (Object.keys(STATUS_STYLE) as StatusRole[]).filter((r) =>
      STATUS_STYLE[r].mark.includes('--series-'),
    );
    assert.deepEqual(seriesBacked, ['info']);
  });
});
