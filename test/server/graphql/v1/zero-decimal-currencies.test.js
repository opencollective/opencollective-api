import { expect } from 'chai';
import gql from 'fake-tag';
import { describe, it } from 'mocha';

import * as store from '../../../stores/index.js';
import * as utils from '../../../utils.js';

describe('server/graphql/v1/zero-decimal-currencies', () => {
  before(async () => {
    await utils.resetTestDB();
    // Given a host
    const { hostCollective } = await store.newHost('JapaneseHost', 'JPY', 5);
    // Given a collective
    const { collective } = await store.newCollectiveInHost('JapaneseCollective', 'JPY', hostCollective, null, {
      isActive: true,
    });
    // And given the host has a stripe account
    await store.stripeConnectedAccount(hostCollective.id);

    const { user } = await store.newUser('Sudharaka');
    const donation = {
      remoteUser: user,
      collective,
      currency: 'JPY',
      amount: 10000,
      ppFee: 35,
      appFee: 25,
      createdAt: new Date(2018, 1, 1, 0, 0),
    };
    await store.stripeOneTimeDonation(donation);
  });

  describe('zero decimal currencies for stripe', () => {
    it('expense submission with zero decimal currencies', async () => {
      const collectiveQuery = gql`
        query Collective($slug: String) {
          Collective(slug: $slug) {
            id
            slug
            transactions {
              amount
              netAmountInCollectiveCurrency(fetchHostFee: true)
              hostFeeInHostCurrency(fetchHostFee: true)
              platformFeeInHostCurrency
              paymentProcessorFeeInHostCurrency
              taxAmount
            }
          }
        }
      `;
      const result = await utils.graphqlQuery(collectiveQuery, {
        slug: 'JapaneseCollective',
      });
      const amount = result.data.Collective.transactions[0].amount;
      const platformFeeInHostCurrency = result.data.Collective.transactions[0].platformFeeInHostCurrency;
      const paymentProcessorFeeInHostCurrency =
        result.data.Collective.transactions[0].paymentProcessorFeeInHostCurrency;
      const hostFeeInHostCurrency = result.data.Collective.transactions[0].hostFeeInHostCurrency;
      const netAmountInCollectiveCurrency = result.data.Collective.transactions[0].netAmountInCollectiveCurrency;

      expect(result.data.Collective).to.exist;
      expect(result.data.Collective.transactions).to.have.length(2);
      expect(amount).to.equal(10000);
      expect(platformFeeInHostCurrency).to.equal(-25 * 100);
      expect(paymentProcessorFeeInHostCurrency).to.equal(-35 * 100);
      expect(hostFeeInHostCurrency).to.equal(-(10000 * 5) / 100); // Resolver is clever enough to retrieve the HOST_FEE transaction
      expect(netAmountInCollectiveCurrency).to.equal(
        amount + (platformFeeInHostCurrency + paymentProcessorFeeInHostCurrency + hostFeeInHostCurrency),
      );
    });
  });
});
