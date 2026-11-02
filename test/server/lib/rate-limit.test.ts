import { expect } from 'chai';
import { range } from 'lodash';

import RateLimit from '../../../server/lib/rate-limit';
import { randStr } from '../../test-helpers/fake-data';

describe('server/lib/rate-limit', () => {
  it('limits the calls with registerCall', async () => {
    const rateLimit = new RateLimit(randStr(), 2);

    expect(await rateLimit.getCallsCount()).to.equal(0);

    expect(await rateLimit.registerCall()).to.equal(true);
    expect(await rateLimit.getCallsCount()).to.equal(1);
    expect(await rateLimit.hasReachedLimit()).to.equal(false);

    expect(await rateLimit.registerCall()).to.equal(true);
    expect(await rateLimit.getCallsCount()).to.equal(2);
    expect(await rateLimit.hasReachedLimit()).to.equal(true);

    // Rejected calls are counted too
    expect(await rateLimit.registerCall()).to.equal(false);
    expect(await rateLimit.getCallsCount()).to.equal(3);

    await rateLimit.reset();
    expect(await rateLimit.getCallsCount()).to.equal(0);
  });

  it('limits concurrent calls', async () => {
    const rateLimit = new RateLimit(randStr(), 5);
    const results = await Promise.all(range(50).map(() => rateLimit.registerCall()));
    expect(results.filter(Boolean)).to.have.length(5);
  });

  it('accepts calls of several units while the count is under the limit', async () => {
    const rateLimit = new RateLimit(randStr(), 10);
    const results = await Promise.all(range(10).map(() => rateLimit.registerCall(3)));
    expect(results.filter(Boolean)).to.have.length(4); // Accepted at 0, 3, 6 and 9
  });

  it('gives back calls with unregisterCall', async () => {
    const rateLimit = new RateLimit(randStr(), 1);
    expect(await rateLimit.registerCall()).to.equal(true);
    await rateLimit.unregisterCall();
    expect(await rateLimit.getCallsCount()).to.equal(0);
    expect(await rateLimit.registerCall()).to.equal(true);
    expect(await rateLimit.registerCall()).to.equal(false);
  });

  it('requires an expiry in whole seconds', () => {
    expect(() => new RateLimit(randStr(), 1, 1.5)).to.throw('Invalid rate limit expiry');
    expect(() => new RateLimit(randStr(), 1, 0)).to.throw('Invalid rate limit expiry');
  });
});
