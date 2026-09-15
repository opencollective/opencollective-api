import { expect } from 'chai';
import config from 'config';
import { createSandbox } from 'sinon';

import cache from '../../../../server/lib/cache';
import { checkManualOrdersLimit } from '../../../../server/lib/security/limit';

describe('lib/security/limit', () => {
  let sandbox;

  beforeEach(async () => {
    await cache.clear();
    sandbox = createSandbox();
    sandbox.stub(config, 'env').value('production'); // The limiter is disabled in test env
    sandbox.stub(config.limits, 'manualOrdersPerHour').value({ perUser: 2, perIp: 3 });
  });

  afterEach(() => sandbox.restore());

  describe('checkManualOrdersLimit', () => {
    it('limits manual orders per user', async () => {
      const user = { id: 42 };
      await checkManualOrdersLimit(user, '1.1.1.1');
      await checkManualOrdersLimit(user, '1.1.1.2');
      await expect(checkManualOrdersLimit(user, '1.1.1.3')).to.be.rejectedWith('Too many contributions');
    });

    it('limits manual orders per IP for guests', async () => {
      await checkManualOrdersLimit(null, '1.1.1.1');
      await checkManualOrdersLimit(null, '1.1.1.1');
      await checkManualOrdersLimit(null, '1.1.1.1');
      await expect(checkManualOrdersLimit(null, '1.1.1.1')).to.be.rejectedWith('Too many contributions');
      await checkManualOrdersLimit(null, '1.1.1.2'); // Other IPs are not affected
    });
  });
});
