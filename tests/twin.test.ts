/**
 * Digital twin tests.
 *
 * Three things are worth testing here and the rest is arithmetic:
 *
 *  1. **Parsing survives a hostile vault.** The vault is edited by humans in
 *     Obsidian. Broken YAML, renamed nodes and half-filled frontmatter are the
 *     normal case, not the exception, and none of them may throw.
 *  2. **The wiki-link nesting collapse is correct.** A single link and a list
 *     of links differ only in how deeply the YAML parser nests them. If that
 *     read is wrong, every relationship in the graph is wrong.
 *  3. **The mandate's edge is honoured.** A bid can clear the 30% strike
 *     trigger and still lose money after both fee legs. That case must refuse.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { seedNodes, seedAssets } from '../server/seed';
import {
  buildGraph,
  fundamentalsIntact,
  link,
  links,
  num,
  parseFrontmatter,
  rows,
  slugOf,
  valueBlock,
  valueEcosystem,
  type FeeTable,
} from '../server/twin';
import type { TwinNode } from '../server/store/types';

const feeTable = (): FeeTable => {
  const fees: FeeTable = {};
  for (const a of seedAssets()) fees[a.asset_class] = { buy: a.buy_fees, sell: a.sell_fees };
  return fees;
};

const node = (over: Partial<TwinNode> & Pick<TwinNode, 'type' | 'filePath' | 'content'>): TwinNode => ({
  id: over.id ?? `n-${over.filePath}`,
  name: over.name ?? 'Node',
  node_id: over.node_id ?? 'ID-1',
  connectedNodes: over.connectedNodes ?? [],
  metrics: over.metrics ?? { status: 'operational' },
  ...over,
});

// ---------------------------------------------------------------- frontmatter
test('Frontmatter parsing', async (t) => {
  await t.test('reads a fenced YAML block and leaves the body alone', () => {
    const { data, body } = parseFrontmatter('---\ntype: city_hub\nnode_id: DET-01\n---\n# Title\ntext\n');
    assert.equal(data.type, 'city_hub');
    assert.equal(data.node_id, 'DET-01');
    assert.match(body, /^# Title/);
  });

  await t.test('a file with no frontmatter is content, not an error', () => {
    const { data, body, error } = parseFrontmatter('# Just a note\n');
    assert.deepEqual(data, {});
    assert.equal(error, undefined);
    assert.equal(body, '# Just a note\n');
  });

  await t.test('malformed YAML is reported, never thrown', () => {
    const result = parseFrontmatter('---\nkey: [unclosed\n---\nbody\n');
    assert.ok(result.error, 'the defect must be surfaced');
    assert.deepEqual(result.data, {});
  });

  await t.test('a frontmatter block that is a list rather than a mapping is rejected', () => {
    const result = parseFrontmatter('---\n- a\n- b\n---\nbody\n');
    assert.ok(result.error);
  });

  await t.test('CRLF line endings parse — vaults get edited on Windows', () => {
    const { data } = parseFrontmatter('---\r\ntype: factory_node\r\n---\r\nbody');
    assert.equal(data.type, 'factory_node');
  });
});

test('Wiki-link reading', async (t) => {
  // `parent_hub: [[City-Detroit]]` parses to [['City-Detroit']];
  // `[ [[A]], [[B]] ]` parses to [[['A']], [['B']]]. Both must read cleanly.
  await t.test('a single link', () => {
    const { data } = parseFrontmatter('---\nparent_hub: [[City-Detroit]]\n---\n');
    assert.equal(link(data.parent_hub), 'City-Detroit');
    assert.deepEqual(links(data.parent_hub), ['City-Detroit']);
  });

  await t.test('a list of links, which nests one level deeper', () => {
    const { data } = parseFrontmatter('---\ndownstream: [ [[W-A]], [[W-B]] ]\n---\n');
    assert.deepEqual(links(data.downstream), ['W-A', 'W-B']);
    assert.equal(link(data.downstream), 'W-A');
  });

  await t.test('a missing field is an empty list, not a crash', () => {
    assert.deepEqual(links(undefined), []);
    assert.equal(link(undefined), null);
  });

  await t.test('num rejects NaN and Infinity rather than propagating them', () => {
    assert.equal(num('12.50'), 12.5);
    assert.equal(num(0), 0);
    assert.equal(num('not a number'), null);
    assert.equal(num(Infinity), null);
    assert.equal(num(NaN), null);
  });

  await t.test('rows tolerates a single mapping written where a list was expected', () => {
    assert.equal(rows({ line_id: 'L1' }).length, 1);
    assert.equal(rows([{ a: 1 }, 'junk', { b: 2 }]).length, 2);
    assert.equal(rows(undefined).length, 0);
  });

  await t.test('slugOf strips the directory and the extension', () => {
    assert.equal(slugOf('30_Logistics_Nodes/Warehouse-Midwest-Alpha.md'), 'Warehouse-Midwest-Alpha');
    assert.equal(slugOf('City-Detroit.md'), 'City-Detroit');
  });
});

// ---------------------------------------------------------------------- graph
test('Supply graph from the seeded vault', async (t) => {
  const graph = buildGraph(seedNodes());

  await t.test('parses every node type', () => {
    assert.equal(graph.hubs.size, 1);
    assert.equal(graph.factories.size, 1);
    assert.equal(graph.warehouses.size, 2);
  });

  await t.test('the shipped vault is clean — a fresh install must not look broken', () => {
    assert.deepEqual(graph.issues, [], JSON.stringify(graph.issues, null, 2));
  });

  await t.test('resolves production lines with their units intact', () => {
    const factory = graph.factories.get('Factory-Detroit-Main')!;
    assert.equal(factory.lines.length, 3);

    const video = factory.lines.find((l) => l.lineId === 'L1-VideoRender')!;
    assert.equal(video.produces, 'H266_Video_NFT');
    assert.equal(video.throughput, 24000);
    assert.equal(video.throughputUnit, 'fps');
    assert.equal(video.marginalCostPerUnit, 0.00012);

    const audio = factory.lines.find((l) => l.lineId === 'L2-AudioSynth')!;
    assert.equal(audio.produces, 'AudioSynth_Stream');
    assert.equal(audio.throughputUnit, 'hz', 'hertz must not be recorded as frames per second');
  });

  await t.test('resolves both directions of the factory/warehouse relationship', () => {
    const factory = graph.factories.get('Factory-Detroit-Main')!;
    assert.deepEqual(factory.downstreamWarehouses, [
      'Warehouse-Midwest-Alpha',
      'Warehouse-Midwest-Beta',
    ]);
    assert.deepEqual(graph.warehouses.get('Warehouse-Midwest-Alpha')!.upstreamFactories, [
      'Factory-Detroit-Main',
    ]);
  });

  await t.test('reads inventory as numbers, not strings', () => {
    const block = graph.warehouses.get('Warehouse-Midwest-Alpha')!.inventory[0];
    assert.equal(block.assetClass, 'H266_Video_NFT');
    assert.equal(block.quantity, 1420);
    assert.equal(block.acquisitionCostPerUnit, 12.5);
    assert.equal(block.marketBidFloor, 16.8);
  });
});

test('Graph validation catches the ways a vault rots', async (t) => {
  await t.test('a renamed hub leaves a dangling link', () => {
    const nodes = seedNodes().filter((n) => n.type !== 'city_hub');
    const graph = buildGraph(nodes);
    const dangling = graph.issues.filter((i) => i.code === 'dangling_hub');
    assert.ok(dangling.length >= 2, 'both the factory and the warehouses must report it');
    assert.ok(dangling.every((i) => i.severity === 'error'));
  });

  await t.test('a one-sided relationship is reported', () => {
    const nodes = seedNodes().map((n) =>
      n.type === 'warehouse_node' && n.node_id === 'MWH-ALPHA'
        ? { ...n, content: n.content.replace('upstream_factories: [ [[Factory-Detroit-Main]] ]', 'upstream_factories: []') }
        : n,
    );
    const graph = buildGraph(nodes);
    assert.ok(graph.issues.some((i) => i.code === 'asymmetric_link'));
  });

  await t.test('inventory nothing upstream can produce is flagged', () => {
    const nodes = seedNodes().map((n) =>
      n.type === 'factory_node'
        ? {
            ...n,
            content: n.content.replace(
              /  - line_id: L3-ComputeMatrix\n[\s\S]*?    status: operational\n/,
              '',
            ),
          }
        : n,
    );
    const graph = buildGraph(nodes);
    assert.ok(
      graph.issues.some((i) => i.code === 'unproducible_inventory'),
      'Compute_Matrix has no line once L3 is removed',
    );
  });

  await t.test('over-allocated storage is an error, not a rounding note', () => {
    const nodes = seedNodes().map((n) =>
      n.type === 'warehouse_node' && n.node_id === 'MWH-ALPHA'
        ? { ...n, content: n.content.replace('storage_capacity_tb: 5000', 'storage_capacity_tb: 100') }
        : n,
    );
    const graph = buildGraph(nodes);
    const issue = graph.issues.find((i) => i.code === 'capacity_exceeded');
    assert.ok(issue);
    assert.equal(issue!.severity, 'error');
  });

  await t.test('one broken file does not take the rest of the vault with it', () => {
    const nodes = [
      ...seedNodes(),
      node({ type: 'factory_node', filePath: '20_Production_Nodes/Broken.md', content: '---\na: [oops\n---\n' }),
    ];
    const graph = buildGraph(nodes);
    assert.ok(graph.issues.some((i) => i.code === 'frontmatter_invalid'));
    assert.equal(graph.factories.size, 1, 'the good factory still parsed');
    assert.equal(graph.warehouses.size, 2);
  });
});

// ------------------------------------------------------------------- breaker
test('Fundamental invalidation breaker reads line health', async (t) => {
  await t.test('operational lines mean fundamentals are intact', () => {
    const graph = buildGraph(seedNodes());
    assert.equal(fundamentalsIntact(graph, 'H266_Video_NFT'), true);
  });

  await t.test('every line for a class degraded means the breaker arms', () => {
    const nodes = seedNodes().map((n) =>
      n.type === 'factory_node'
        ? {
            ...n,
            content: n.content.replace(
              '    max_throughput_fps: 24000\n    marginal_cost_per_frame: 0.00012\n    status: operational',
              '    max_throughput_fps: 24000\n    marginal_cost_per_frame: 0.00012\n    status: degraded',
            ),
          }
        : n,
    );
    const graph = buildGraph(nodes);
    assert.equal(fundamentalsIntact(graph, 'H266_Video_NFT'), false);
    assert.equal(fundamentalsIntact(graph, 'AudioSynth_Stream'), true, 'unrelated classes are unaffected');
  });

  await t.test('an empty graph does not halt everything', () => {
    // "No lines declared" is not evidence of failure. A brand-new tenant with
    // an empty vault must not have every acquisition refused.
    const graph = buildGraph([]);
    assert.equal(fundamentalsIntact(graph, 'H266_Video_NFT'), true);
  });
});

// ----------------------------------------------------------------- valuation
test('Mandate valuation', async (t) => {
  const graph = buildGraph(seedNodes());
  const valuation = valueEcosystem(graph, feeTable());

  await t.test('reproduces the specification worked example', () => {
    // Spec p.26: acquisition $12.50, target strike floor $16.25 (30% trigger),
    // active bid $16.80 -> AUTO-STRIKE TRIGGERED.
    const h266 = valuation.blocks.find((b) => b.assetClass === 'H266_Video_NFT')!;
    assert.equal(h266.acquisitionCostPerUnit, 12.5);
    assert.equal(h266.strikeFloor, 16.25);
    assert.equal(h266.marketBidFloor, 16.8);
    assert.equal(h266.verdict, 'SELL_STRIKE');
    assert.equal(h266.stopFloor, 10.625);
  });

  await t.test('buffer load is derived, not asserted', () => {
    // Spec p.26 shows "Current Buffer Load: 42%". Here it falls out of
    // 1,420 blocks x 1.48 TB against 5,000 TB of declared capacity.
    const alpha = valuation.warehouses.find((w) => w.nodeId === 'MWH-ALPHA')!;
    assert.equal(alpha.storageUsedTb, 2101.6);
    assert.ok(alpha.utilisation !== null);
    assert.ok(Math.abs(alpha.utilisation! - 0.4203) < 1e-4, String(alpha.utilisation));
  });

  await t.test('valuation is the sum of quantity x bid', () => {
    // 1420*16.80 + 500*52.50 + 250*95.00
    assert.equal(valuation.totalValuation, 23856 + 26250 + 23750);
  });

  await t.test('a holding between the floors holds', () => {
    const compute = valuation.blocks.find((b) => b.assetClass === 'Compute_Matrix')!;
    assert.equal(compute.verdict, 'HOLD');
    assert.ok(compute.netYieldPerUnit < 0, 'underwater, but not yet through the stop');
  });

  await t.test('utilisation is null when a block size is missing, never zero', () => {
    const nodes = seedNodes().map((n) =>
      n.type === 'warehouse_node' && n.node_id === 'MWH-ALPHA'
        ? { ...n, content: n.content.replace('    block_size_tb: 1.48\n', '') }
        : n,
    );
    const withGap = valueEcosystem(buildGraph(nodes), feeTable());
    const alpha = withGap.warehouses.find((w) => w.nodeId === 'MWH-ALPHA')!;
    assert.equal(alpha.utilisation, null, 'a missing field must not read as an empty warehouse');
  });
});

test('The strike trigger is not the same as a profitable trade', async (t) => {
  const warehouse = {
    kind: 'warehouse' as const,
    slug: 'W',
    nodeId: 'W-1',
    name: 'W',
    parentHub: null,
    upstreamFactories: [],
    storageCapacityTb: 0,
    inventory: [],
    filePath: 'W.md',
  };

  await t.test('a bid clearing the 30% trigger but losing to fees is refused', () => {
    // 30% gross gain, 25% of it handed back in fees on both legs.
    const block = {
      assetClass: 'H266_Video_NFT' as const,
      quantity: 10,
      acquisitionCostPerUnit: 100,
      marketBidFloor: 130,
      blockSizeTb: 1,
    };
    const fees: FeeTable = { H266_Video_NFT: { buy: 0.15, sell: 0.15 } };
    const valued = valueBlock(warehouse, block, fees);

    assert.equal(valued.strikeTriggered, true, 'the gross trigger does fire');
    assert.ok(valued.netYieldPerUnit < 0, 'and the trade still loses money');
    assert.equal(valued.verdict, 'HOLD_UNECONOMIC');
    assert.equal(valued.strikeUneconomic, true);
    assert.match(valued.reason, /fee legs/);
  });

  await t.test('the same bid with ordinary fees strikes', () => {
    const block = {
      assetClass: 'H266_Video_NFT' as const,
      quantity: 10,
      acquisitionCostPerUnit: 100,
      marketBidFloor: 130,
      blockSizeTb: 1,
    };
    const fees: FeeTable = { H266_Video_NFT: { buy: 0.02, sell: 0.025 } };
    assert.equal(valueBlock(warehouse, block, fees).verdict, 'SELL_STRIKE');
  });

  await t.test('the stop fires even though selling realises a loss', () => {
    // A stop that only fired on profitable exits would not be a stop.
    const block = {
      assetClass: 'H266_Video_NFT' as const,
      quantity: 10,
      acquisitionCostPerUnit: 100,
      marketBidFloor: 80,
      blockSizeTb: 1,
    };
    const valued = valueBlock(warehouse, block, { H266_Video_NFT: { buy: 0.02, sell: 0.025 } });
    assert.equal(valued.verdict, 'SELL_STOP_LOSS');
    assert.ok(valued.netYieldTotal < 0);
  });

  await t.test('an asset class with no fee entry is priced at zero fees, not NaN', () => {
    const block = {
      assetClass: 'Compute_Matrix' as const,
      quantity: 1,
      acquisitionCostPerUnit: 10,
      marketBidFloor: 20,
      blockSizeTb: 1,
    };
    const valued = valueBlock(warehouse, block, {});
    assert.equal(valued.netYieldPerUnit, 10);
    assert.equal(valued.verdict, 'SELL_STRIKE');
  });
});
