import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseSource, ArtifactCompileError } from '../src/lib/compileArtifact';

describe('normaliseSource', () => {
  it('passes through a bare function body', () => {
    const out = normaliseSource('return (<div>hi</div>);');
    assert.match(out, /^return \(<div>hi<\/div>\);$/);
  });

  it('wraps a bare JSX expression in a return', () => {
    assert.equal(normaliseSource('<div>hi</div>'), 'return (<div>hi</div>);');
  });

  it('strips markdown fences the model added anyway', () => {
    const out = normaliseSource('```jsx\nreturn (<p>x</p>);\n```');
    assert.equal(out, 'return (<p>x</p>);');
  });

  it('strips import statements, which cannot exist in a function body', () => {
    const out = normaliseSource("import React from 'react';\nreturn (<p>x</p>);");
    assert.ok(!out.includes('import'));
  });

  it('delegates to a full component declaration', () => {
    const out = normaliseSource('function Widget({ data }) { return (<b>{data.x}</b>); }');
    assert.match(out, /return Widget\(__apexProps\);$/);
  });

  it('handles export default in front of a declaration', () => {
    const out = normaliseSource('export default function Widget() { return (<b/>); }');
    assert.ok(!out.includes('export default'));
    assert.match(out, /return Widget\(__apexProps\);$/);
  });

  it('rejects empty source', () => {
    assert.throws(() => normaliseSource('   '), ArtifactCompileError);
  });

  it('rejects source over the size limit', () => {
    assert.throws(() => normaliseSource('x'.repeat(70_000)), ArtifactCompileError);
  });
});
