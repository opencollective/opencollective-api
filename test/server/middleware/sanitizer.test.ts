import { expect } from 'chai';
import sinon from 'sinon';

import getSanitizer from '../../../server/middleware/sanitizer';

const sanitize = getSanitizer();

describe('server/middleware/sanitizer', () => {
  const testSanitize = (body, expected) => {
    const next = sinon.spy();
    const input = { body };
    expect(sanitize(input, null, next)).to.be.undefined;
    expect(next.calledOnce).to.be.true;
    expect(input.body).to.deep.equal(expected);
  };

  it('works with empty object', () => {
    testSanitize({}, {});
  });

  it('works with basic object', () => {
    testSanitize({ foo: 'bar' }, { foo: 'bar' });
  });

  it('works with string', () => {
    testSanitize({ foo: 'hello' }, { foo: 'hello' });
    testSanitize({ foo: '<script>alert("bar")</script>' }, { foo: '' });
  });

  it('works with array', () => {
    testSanitize({ foo: ['hello', 'world'] }, { foo: ['hello', 'world'] });
    testSanitize({ foo: ['<script>alert("bar")</script>'] }, { foo: [''] });
  });
});
