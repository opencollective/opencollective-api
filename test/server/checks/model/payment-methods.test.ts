import { expect } from 'chai';

import {
  checkCollectivePaymentMethodsCurrencies,
  checkHostPaymentMethodsCurrencies,
} from '../../../../checks/model/payment-methods';
import type { SupportedCurrency } from '../../../../server/constants/currencies';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../../../server/constants/paymentMethods';
import models from '../../../../server/models';
import { fakeActiveHost, fakeCollective, fakePaymentMethod, fakeTransaction } from '../../../test-helpers/fake-data';
import { resetTestDB } from '../../../utils';

const fakeOpenCollectivePaymentMethod = (
  CollectiveId: number,
  type: PAYMENT_METHOD_TYPE,
  currency: SupportedCurrency,
) => fakePaymentMethod({ CollectiveId, service: PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE, type, currency });

describe('checks/model/payment-methods', () => {
  beforeEach(async () => {
    await resetTestDB();
  });

  describe('checkCollectivePaymentMethodsCurrencies', () => {
    it('does not throw when collective payment methods match the host currency', async () => {
      const host = await fakeActiveHost({ currency: 'EUR' });
      const collective = await fakeCollective({ HostCollectiveId: host.id, currency: 'EUR' });
      await fakeOpenCollectivePaymentMethod(collective.id, PAYMENT_METHOD_TYPE.COLLECTIVE, 'EUR');

      await expect(checkCollectivePaymentMethodsCurrencies({ fix: false })).to.be.fulfilled;
    });

    it('throws, then fixes, when a collective payment method does not match the host currency', async () => {
      const host = await fakeActiveHost({ currency: 'EUR' });
      const collective = await fakeCollective({ HostCollectiveId: host.id, currency: 'EUR' });
      const pm = await fakeOpenCollectivePaymentMethod(collective.id, PAYMENT_METHOD_TYPE.COLLECTIVE, 'USD');

      await expect(checkCollectivePaymentMethodsCurrencies({ fix: false })).to.be.rejectedWith(
        'Collective payment method must have the same currency as the host',
      );

      await checkCollectivePaymentMethodsCurrencies({ fix: true });
      await pm.reload();
      expect(pm.currency).to.eq('EUR');
      await expect(checkCollectivePaymentMethodsCurrencies({ fix: false })).to.be.fulfilled;
    });
  });

  describe('checkHostPaymentMethodsCurrencies', () => {
    it('does not throw when host payment methods match the host currency', async () => {
      const host = await fakeActiveHost({ currency: 'EUR' });
      await fakeOpenCollectivePaymentMethod(host.id, PAYMENT_METHOD_TYPE.HOST, 'EUR');

      await expect(checkHostPaymentMethodsCurrencies({ fix: false })).to.be.fulfilled;
    });

    it('ignores payment methods that were already used in transactions', async () => {
      const host = await fakeActiveHost({ currency: 'EUR' });
      const pm = await fakeOpenCollectivePaymentMethod(host.id, PAYMENT_METHOD_TYPE.HOST, 'USD');
      await fakeTransaction({ PaymentMethodId: pm.id, HostCollectiveId: host.id });

      await expect(checkHostPaymentMethodsCurrencies({ fix: false })).to.be.fulfilled;
    });

    it('throws, then updates the currency, when an unused host payment method does not match the host currency', async () => {
      const host = await fakeActiveHost({ currency: 'EUR' });
      const pm = await fakeOpenCollectivePaymentMethod(host.id, PAYMENT_METHOD_TYPE.HOST, 'USD');

      await expect(checkHostPaymentMethodsCurrencies({ fix: false })).to.be.rejectedWith(
        'Host payment method must have the same currency as the host',
      );

      await checkHostPaymentMethodsCurrencies({ fix: true });
      await pm.reload();
      expect(pm.currency).to.eq('EUR');
      await expect(checkHostPaymentMethodsCurrencies({ fix: false })).to.be.fulfilled;
    });

    it('deletes the unused stale payment method when one already exists in the host currency', async () => {
      const host = await fakeActiveHost({ currency: 'EUR' });
      const stalePm = await fakeOpenCollectivePaymentMethod(host.id, PAYMENT_METHOD_TYPE.HOST, 'USD');
      const validPm = await fakeOpenCollectivePaymentMethod(host.id, PAYMENT_METHOD_TYPE.HOST, 'EUR');

      await checkHostPaymentMethodsCurrencies({ fix: true });

      expect(await models.PaymentMethod.findByPk(stalePm.id)).to.be.null;
      await validPm.reload(); // Throws if it was deleted
      expect(validPm.currency).to.eq('EUR');
      await expect(checkHostPaymentMethodsCurrencies({ fix: false })).to.be.fulfilled;
    });
  });
});
