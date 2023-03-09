import { expect } from 'chai';
import gqlV2 from 'fake-tag';
import { createSandbox } from 'sinon';

import models, { PaymentMethod } from '../../../../../server/models';
import { fakeCollective, fakeOrder, fakeUser } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2 } from '../../../../utils';
import * as utils from '../../../../utils';

describe('server/graphql/v2/mutation/PaymentMethodMutations', () => {
  describe('addCreditCard', () => {
    const addCreditCardMutation = gqlV2/* GraphQL */ `
      mutation AddCreditCard(
        $creditCardInfo: CreditCardCreateInput!
        $name: String!
        $account: AccountReferenceInput!
      ) {
        addCreditCard(creditCardInfo: $creditCardInfo, name: $name, account: $account) {
          paymentMethod {
            id
            name
            data
          }
          stripeError {
            message
            response
          }
        }
      }
    `;

    let user, collective, order, sandbox, result;

    before(async () => {
      sandbox = createSandbox();
      user = await fakeUser();
      collective = await fakeCollective({
        admin: user.collective,
      });
      result = await graphqlQueryV2(
        addCreditCardMutation,
        {
          creditCardInfo: {
            token: 'tok_visa',
          },
          name: '1990',
          account: { legacyId: collective.id },
        },
        user,
      );
      const paymentMethod = await models.PaymentMethod.findAll({ where: { token: 'tok_visa' } });
      order = await fakeOrder({ PaymentMethodId: paymentMethod[0].id });
    });

    after(async () => {
      sandbox.restore();
      await utils.resetTestDB();
    });

    it('correctly creates a credit card payment method', async () => {
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.addCreditCard.paymentMethod.name).is.equal('1990');
      expect(result.data.addCreditCard.paymentMethod.data.brand).is.equal('Visa');
    });

    it('if update is successful, delete old payment method and updates associated contributions', async () => {
      result = await graphqlQueryV2(
        addCreditCardMutation,
        {
          creditCardInfo: {
            token: 'tok_visa',
          },
          name: '1993',
          account: { legacyId: collective.id },
        },
        user,
      );

      const paymentMethod = await models.PaymentMethod.findAll({ where: { token: 'tok_visa' } });
      const updatedOrder = await models.Order.findOne({ where: { id: order.id } });

      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(paymentMethod).to.have.length(1);
      expect(paymentMethod[0].name).is.equal('1993');
      expect(updatedOrder.PaymentMethodId).is.equal(paymentMethod[0].id);
    });

    it('when failing to create new PaymentMethod, do not delete old payment method', async () => {
      sandbox.stub(PaymentMethod, 'create').callsFake(() => {
        throw Error('Failed to create payment method');
      });

      const duplicateCardResult = await graphqlQueryV2(
        addCreditCardMutation,
        {
          creditCardInfo: {
            token: 'tok_visa',
          },
          name: '1995',
          account: { legacyId: collective.id },
        },
        user,
      );

      const paymentMethod = await models.PaymentMethod.findAll({ where: { token: 'tok_visa' } });
      const updatedOrder = await models.Order.findOne({ where: { id: order.id } });

      expect(duplicateCardResult.errors).exist;
      expect(duplicateCardResult.errors[0].message).to.equal('Failed to create payment method');
      expect(paymentMethod).to.have.length(1);
      expect(paymentMethod[0].name).is.equal('1993');
      expect(updatedOrder.PaymentMethodId).is.equal(paymentMethod[0].id);
    });
  });
});
