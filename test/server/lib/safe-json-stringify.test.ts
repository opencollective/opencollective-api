import { expect } from 'chai';

import { safeJsonStringify } from '../../../server/lib/safe-json-stringify';

describe('server/lib/safe-json-stringify', () => {
  it('removes circular references', () => {
    const obj = { a: 'a' };
    obj['b'] = obj;
    expect(safeJsonStringify(obj)).to.equal('{"a":"a","b":"[Circular]"}');
  });
});
