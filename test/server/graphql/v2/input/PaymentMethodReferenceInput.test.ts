import { expect } from 'chai';

import { idEncode, IDENTIFIER_TYPES } from '../../../../../server/graphql/v2/identifiers';
import {
  fetchPaymentMethodWithReference,
  fetchPaymentMethodWithReferences,
} from '../../../../../server/graphql/v2/input/PaymentMethodReferenceInput';
import { fakePaymentMethod } from '../../../../test-helpers/fake-data';
import { resetTestDB } from '../../../../utils';

describe('server/graphql/v2/input/PaymentMethodReferenceInput', () => {
  let paymentMethods;

  before(async () => {
    await resetTestDB();
    paymentMethods = await Promise.all([fakePaymentMethod(), fakePaymentMethod(), fakePaymentMethod()]);
  });

  describe('fetchPaymentMethodWithReference', () => {
    it('fetches by legacy id, encoded id or public id', async () => {
      const [paymentMethod] = paymentMethods;
      for (const reference of [
        { legacyId: paymentMethod.id },
        { id: idEncode(paymentMethod.id, IDENTIFIER_TYPES.PAYMENT_METHOD) },
        { id: paymentMethod.publicId },
      ]) {
        const result = await fetchPaymentMethodWithReference(reference);
        expect(result.id).to.equal(paymentMethod.id);
      }
    });

    it('throws when the payment method does not exist or no identifier is given', async () => {
      await expect(fetchPaymentMethodWithReference({ legacyId: 999999999 })).to.be.rejectedWith(
        'Payment Method Not Found',
      );
      await expect(fetchPaymentMethodWithReference({})).to.be.rejectedWith('Please provide an id or a legacyId');
    });
  });

  describe('fetchPaymentMethodWithReferences', () => {
    it('fetches a mix of legacy ids, encoded ids and public ids', async () => {
      const [first, second, third] = paymentMethods;
      const results = await fetchPaymentMethodWithReferences([
        { legacyId: first.id },
        { id: idEncode(second.id, IDENTIFIER_TYPES.PAYMENT_METHOD) },
        { id: third.publicId },
        { legacyId: first.id },
      ]);
      expect(results.map(pm => pm.id)).to.have.members([first.id, second.id, third.id]);
    });

    it('throws when a reference has no identifier', async () => {
      await expect(fetchPaymentMethodWithReferences([{ legacyId: paymentMethods[0].id }, {}])).to.be.rejectedWith(
        'Please provide an id or a legacyId',
      );
    });
  });
});
