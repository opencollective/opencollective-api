import { expect } from 'chai';
import gqlV1 from 'fake-tag';
import { describe, it } from 'mocha';
import { createSandbox } from 'sinon';

import { VAT_OPTIONS } from '../../../../server/constants/vat';
import stripe from '../../../../server/lib/stripe';
import models from '../../../../server/models';
import { fakeCollective, fakePrivateHost, fakeTier, fakeUser, randStr } from '../../../test-helpers/fake-data';
import * as utils from '../../../utils';

describe('server/graphql/v1/tiers', () => {
  let user1, host, collective1, collective2;
  let sandbox;

  beforeEach(() => utils.resetTestDB());

  /**
   * Setup:
   * - User1 is a member of collective2 has a payment method on file
   * - User1 will become a backer of collective1
   * - Host is the host of both collective1 and collective2. It has a tax on "PRODUCT" tiers.
   */
  // Create users
  beforeEach(async () => {
    user1 = await models.User.createUserWithCollective(utils.data('user1'));
  });

  // Create host
  beforeEach(async () => {
    host = await models.User.createUserWithCollective(utils.data('host1'));
    await host.collective.update({ countryISO: 'BE', settings: { VAT: { type: 'OWN', number: 'FRXX999999999' } } });
  });

  // Create test collectives
  beforeEach(async () => {
    collective1 = await models.Collective.create({
      ...utils.data('collective1'),
      countryISO: 'BE',
      settings: { VAT: { type: VAT_OPTIONS.HOST } },
    });
  });
  beforeEach(async () => {
    collective2 = await models.Collective.create(utils.data('collective2'));
  });

  // Create tiers
  beforeEach(async () => {
    await collective1.createTier(utils.data('tier1'));
  });

  // Add hosts to collectives
  beforeEach(() => collective1.addHost(host.collective, host));
  beforeEach(() => collective2.addHost(host.collective, host));
  beforeEach(() => collective2.addUserWithRole(user1, 'ADMIN'));

  beforeEach('create stripe account', async () => {
    await models.ConnectedAccount.create({
      service: 'stripe',
      CollectiveId: host.collective.id,
      token: 'abc',
      username: 'stripeAccount',
    });
  });

  before(() => {
    sandbox = createSandbox();
  });

  after(() => sandbox.restore());

  before(() => {
    sandbox.stub(stripe.tokens, 'create').callsFake(() => Promise.resolve({ id: 'tok_B5s4wkqxtUtNyM' }));
    sandbox.stub(stripe.tokens, 'retrieve').callsFake(() => Promise.resolve({ id: 'tok_B5s4wkqxtUtNyM', card: {} }));

    sandbox.stub(stripe.customers, 'create').callsFake(() => Promise.resolve({ id: 'cus_B5s4wkqxtUtNyM' }));
    sandbox.stub(stripe.customers, 'retrieve').callsFake(() => Promise.resolve({ id: 'cus_B5s4wkqxtUtNyM' }));

    const paymentMethodId = randStr('pm_');
    sandbox
      .stub(stripe.paymentMethods, 'create')
      .resolves({ id: paymentMethodId, type: 'card', card: { fingerprint: 'fingerprint' } });
    sandbox
      .stub(stripe.paymentMethods, 'attach')
      .resolves({ id: paymentMethodId, type: 'card', card: { fingerprint: 'fingerprint' } });

    /* eslint-disable camelcase */

    sandbox.stub(stripe.paymentIntents, 'create').callsFake(() =>
      Promise.resolve({
        id: 'pi_1F82vtBYycQg1OMfS2Rctiau',
        status: 'requires_confirmation',
      }),
    );

    sandbox.stub(stripe.paymentIntents, 'confirm').callsFake(data =>
      Promise.resolve({
        charges: {
          data: [
            {
              id: 'ch_1AzPXHD8MNtzsDcgXpUhv4pm',
              amount: data.amount,
              balance_transaction: 'txn_19XJJ02eZvKYlo2ClwuJ1rbA',
            },
          ],
        },
        status: 'succeeded',
      }),
    );

    const balanceTransaction = {
      id: 'txn_19XJJ02eZvKYlo2ClwuJ1rbA',
      object: 'balance_transaction',
      amount: 999,
      available_on: 1483920000,
      created: 1483315442,
      currency: 'usd',
      description: null,
      fee: 59,
      fee_details: [
        {
          amount: 59,
          application: null,
          currency: 'usd',
          description: 'Stripe processing fees',
          type: 'stripe_fee',
        },
      ],
      net: 940,
      source: 'ch_19XJJ02eZvKYlo2CHfSUsSpl',
      status: 'pending',
      type: 'charge',
    };
    sandbox.stub(stripe.balanceTransactions, 'retrieve').callsFake(() => Promise.resolve(balanceTransaction));

    /* eslint-enable camelcase */
  });

  describe('fetch a tier directly by id (Tier query)', () => {
    it('does not allow a random user to fetch a tier belonging to a private organization', async () => {
      const privateHost = await fakePrivateHost();
      const privateCollective = await fakeCollective({
        HostCollectiveId: privateHost.id,
        isPrivate: true,
        approvedAt: new Date(),
      });
      const privateTier = await fakeTier({ CollectiveId: privateCollective.id });
      const randomUser = await fakeUser();

      const tierQuery = gqlV1 /* GraphQL */ `
        query Tier($id: Int!) {
          Tier(id: $id) {
            id
            name
          }
        }
      `;

      const res = await utils.graphqlQuery(tierQuery, { id: privateTier.id }, randomUser);
      expect(res.errors).to.exist;
      expect(res.data?.Tier).to.not.exist;
    });

    it('allows an admin of the private collective to fetch its tier', async () => {
      const privateHost = await fakePrivateHost();
      const collectiveAdminUser = await fakeUser();
      const privateCollective = await fakeCollective({
        HostCollectiveId: privateHost.id,
        isPrivate: true,
        approvedAt: new Date(),
        admin: collectiveAdminUser.collective,
      });
      const privateTier = await fakeTier({ CollectiveId: privateCollective.id });

      const tierQuery = gqlV1 /* GraphQL */ `
        query Tier($id: Int!) {
          Tier(id: $id) {
            id
            name
          }
        }
      `;

      const res = await utils.graphqlQuery(tierQuery, { id: privateTier.id }, collectiveAdminUser);
      res.errors && console.error(res.errors[0]);
      expect(res.errors).to.not.exist;
      expect(res.data.Tier.id).to.equal(privateTier.id);
    });

    it('allows an admin of the private host to fetch a tier of a hosted private collective', async () => {
      const hostAdminUser = await fakeUser();
      const privateHost = await fakePrivateHost({ admin: hostAdminUser.collective });
      const privateCollective = await fakeCollective({
        HostCollectiveId: privateHost.id,
        isPrivate: true,
        approvedAt: new Date(),
      });
      const privateTier = await fakeTier({ CollectiveId: privateCollective.id });

      const tierQuery = gqlV1 /* GraphQL */ `
        query Tier($id: Int!) {
          Tier(id: $id) {
            id
            name
          }
        }
      `;

      const res = await utils.graphqlQuery(tierQuery, { id: privateTier.id }, hostAdminUser);
      res.errors && console.error(res.errors[0]);
      expect(res.errors).to.not.exist;
      expect(res.data.Tier.id).to.equal(privateTier.id);
    });
  });

  describe('graphql.tiers.test', () => {
    describe('fetch tiers of a collective', () => {
      beforeEach(() =>
        collective1.createTier({
          slug: 'bronze-sponsor',
          name: 'bronze sponsor',
          amount: 0,
        }),
      );
      beforeEach(() => collective1.createTier({ slug: 'gold-sponsor', name: 'gold sponsor', amount: 0 }));

      const collectiveTiersQuery = gqlV1 /* GraphQL */ `
        query CollectiveTiers($collectiveSlug: String, $tierSlug: String, $tierId: Int) {
          Collective(slug: $collectiveSlug) {
            tiers(slug: $tierSlug, id: $tierId) {
              id
              name
            }
          }
        }
      `;

      it('fetch all tiers', async () => {
        const res = await utils.graphqlQuery(collectiveTiersQuery, {
          collectiveSlug: collective1.slug,
        });
        res.errors && console.error(res.errors[0]);
        expect(res.errors).to.not.exist;
        const tiers = res.data.Collective.tiers;
        expect(tiers).to.have.length(3);
      });

      it('filter tiers by slug', async () => {
        const res = await utils.graphqlQuery(collectiveTiersQuery, {
          collectiveSlug: collective1.slug,
          tierSlug: 'bronze-sponsor',
        });
        res.errors && console.error(res.errors[0]);
        expect(res.errors).to.not.exist;
        const tiers = res.data.Collective.tiers;
        expect(tiers).to.have.length(1);
        expect(tiers[0].name).to.equal('bronze sponsor');
      });

      it('filter tiers by tierId', async () => {
        const res = await utils.graphqlQuery(collectiveTiersQuery, {
          collectiveSlug: collective1.slug,
          tierId: 1,
        });
        res.errors && console.error(res.errors[0]);
        expect(res.errors).to.not.exist;
        const tiers = res.data.Collective.tiers;
        expect(tiers).to.have.length(1);
        expect(tiers[0].id).to.equal(1);
      });
    });
  });
});
