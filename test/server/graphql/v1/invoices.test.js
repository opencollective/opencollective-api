/** @module test/graphql.invoices.test
 *
 * This tests all the GraphQL API methods that interact with user
 * invoices. */

import { expect } from 'chai';
import gqlV1 from 'fake-tag';
import { useFakeTimers } from 'sinon';

import * as store from '../../../stores';
import * as utils from '../../../utils';

/** Create host, collective, payment method and make a donation
 *
 * As a bonus feature, this helper freezes time at `createdAt' so all
 * the objects created will have that date as their creation date.
 *
 * The payment method is always stripe for now.
 */
async function donate(user, currency, amount, createdAt, collective) {
  const timer = useFakeTimers(new Date(createdAt).getTime());
  try {
    await store.stripeConnectedAccount(collective.HostCollectiveId);
    await store.stripeOneTimeDonation({
      remoteUser: user,
      collective,
      currency,
      amount,
    });
  } finally {
    timer.restore();
  }
}

describe('server/graphql/v1/invoices', () => {
  let xdamman;

  before(async () => {
    // First reset the test database
    await utils.resetTestDB();
    // Given a user and its collective
    const { user } = await store.newUser('xdamman');
    xdamman = user;
    // And given the collective (with their host)
    const { collective } = await store.newCollectiveWithHost('brusselstogether', 'EUR', 'EUR', 10);
    // And given some donations to that collective
    await donate(user, 'EUR', 1000, '2017-09-03 00:00', collective);
    await donate(user, 'EUR', 1000, '2017-10-05 00:00', collective);
    await donate(user, 'EUR', 500, '2017-10-25 00:00', collective);
    await donate(user, 'EUR', 500, '2017-11-05 00:00', collective);
    await donate(user, 'EUR', 500, '2017-11-25 00:00', collective);
  });

  describe('return transactions', () => {
    it('fails to return list of invoices for a given user if not logged in as that user', async () => {
      const query = gqlV1/* GraphQL */ `
        query AllInvoices($fromCollectiveSlug: String!) {
          allInvoices(fromCollectiveSlug: $fromCollectiveSlug) {
            year
            month
            host {
              id
              slug
            }
          }
        }
      `;
      const result = await utils.graphqlQuery(query, {
        fromCollectiveSlug: 'xdamman',
      });
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.contain("You don't have permission to access invoices for this user");
    });

    it('returns list of invoices for a given user', async () => {
      const query = gqlV1/* GraphQL */ `
        query AllInvoices($fromCollectiveSlug: String!) {
          allInvoices(fromCollectiveSlug: $fromCollectiveSlug) {
            year
            month
            totalAmount
            currency
            host {
              id
              slug
            }
            fromCollective {
              id
              slug
            }
          }
        }
      `;
      const result = await utils.graphqlQuery(query, { fromCollectiveSlug: 'xdamman' }, xdamman);
      result.errors && console.error(result.errors[0]);
      expect(result.errors).to.not.exist;
      const invoices = result.data.allInvoices;
      expect(invoices).to.have.length(3);
      expect(invoices[0].year).to.equal(2017);
      expect(invoices[0].month).to.equal(11);
      expect(invoices[0].host.slug).to.equal('brusselstogether-host');
      expect(invoices[0].fromCollective.slug).to.equal('xdamman');
    });
  });
});
