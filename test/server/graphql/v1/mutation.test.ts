import * as SentrySdk from '@sentry/node';
import * as chai from 'chai';
import config from 'config';
import gqlV1 from 'fake-tag';
import { describe, it } from 'mocha';
import { createSandbox } from 'sinon';

import { CollectiveType } from '../../../../server/constants/collectives';
import roles from '../../../../server/constants/roles';
import { createOrder } from '../../../../server/graphql/v1/mutations/orders';
import models from '../../../../server/models';
import creditcard from '../../../../server/paymentProviders/stripe/creditcard';
import { fakeActiveHost, fakeCollective, fakeProject, fakeUser } from '../../../test-helpers/fake-data';
import * as utils from '../../../utils';

let host, user1, user2, user3, collective1;
let sandbox;

const { expect } = chai;

describe('server/graphql/v1/mutation', () => {
  /* SETUP
    collective1: 2 events
      event1: 1 free ticket, 1 paid ticket
  */

  before(() => {
    sandbox = createSandbox();
  });

  after(() => sandbox.restore());

  beforeEach('reset db', async () => {
    await new Promise(res => setTimeout(res, 500));
    await utils.resetTestDB();
  });

  beforeEach('create user1', async () => {
    user1 = await models.User.createUserWithCollective(utils.data('user1'));
  });
  beforeEach('create host user 1', async () => {
    host = await models.User.createUserWithCollective({
      ...utils.data('host1'),
      currency: 'EUR',
    });
  });

  beforeEach('create user2', async () => {
    user2 = await models.User.createUserWithCollective(utils.data('user2'));
  });
  beforeEach('create user3', async () => {
    user3 = await models.User.createUserWithCollective(utils.data('user3'));
  });
  beforeEach('create collective1', async () => {
    collective1 = await models.Collective.create(utils.data('collective1'));
  });
  beforeEach('add host', () => collective1.addHost(host.collective, host));
  beforeEach('add user1 as admin to collective1', () => collective1.addUserWithRole(user1, roles.ADMIN));
  beforeEach('add user2 as admin to collective1', () => collective1.addUserWithRole(user2, roles.ADMIN));

  beforeEach('create stripe account', async () => {
    await models.ConnectedAccount.create({
      service: 'stripe',
      token: 'abc',
      username: 'stripeAccount',
      CollectiveId: host.collective.id,
    });
  });

  beforeEach('create an event collective', async () => {
    await models.Collective.create(
      Object.assign(utils.data('event1'), {
        CreatedByUserId: user1.id,
        ParentCollectiveId: collective1.id,
        HostCollectiveId: collective1.HostCollectiveId,
        isActive: true,
        approvedAt: new Date(),
      }),
    );
  });

  beforeEach('create a project  under collective1', async () => {
    await fakeProject({
      ParentCollectiveId: collective1.id,
      HostCollectiveId: collective1.HostCollectiveId,
      isActive: true,
      approvedAt: new Date(),
    });
  });

  describe('createCollective tests', () => {
    const createCollectiveMutation = gqlV1 /* GraphQL */ `
      mutation CreateCollective($collective: CollectiveInputType!) {
        createCollective(collective: $collective) {
          id
          slug
          currency
          hostFeePercent
          host {
            id
            currency
          }
          parentCollective {
            id
            currency
          }
          isActive
          tiers {
            id
            name
            amount
            presets
          }
        }
      }
    `;

    describe('creates an event collective', () => {
      const getEventData = (collective): { id?: number; [key: string]: unknown } => {
        return {
          name: 'BrusselsTogether Meetup 3',
          type: CollectiveType.EVENT,
          longDescription:
            'Hello Brussels!\n\nAccording to the UN, by 2050 66% of the world’s population will be urban dwellers, which will profoundly affect the role of modern city-states on Earth.\n\nToday, citizens are already anticipating this futurist trend by creating numerous initiatives inside their local communities and outside of politics.\n\nIf you want to be part of the change, please come have a look to our monthly events! You will have the opportunity to meet real actors of change and question them about their purpose. \n\nWe also offer the opportunity for anyone interested to come before the audience and share their ideas in 60 seconds at the end of the event.\n\nSee more about #BrusselsTogether radical way of thinking below.\n\nhttps://brusselstogether.org/\n\nGet your ticket below and get a free drink thanks to our sponsor! 🍻🎉\n\n**Schedule**\n\n7 pm - Doors open\n\n7:30 pm - Introduction to #BrusselsTogether\n\n7:40 pm - Co-Labs, Citizen Lab of Social Innovations\n\n7:55 pm - BeCode.org, growing today’s talented youth into tomorrow’s best developers.\n\n8:10 pm - OURB, A city building network\n\n8:30 pm - How do YOU make Brussels better \nPitch your idea in 60 seconds or less\n',
          location: {
            name: "Brass'Art Digitaal Cafe",
            address: 'Place communale de Molenbeek 28',
          },
          startsAt: 'Wed Apr 05 2017 10:00:00 GMT-0700 (PDT)',
          endsAt: 'Wed Apr 05 2017 12:00:00 GMT-0700 (PDT)',
          timezone: 'Europe/Brussels',
          ParentCollectiveId: collective.id,
        };
      };

      it('fails if not authenticated', async () => {
        const result = await utils.graphqlQuery(createCollectiveMutation, {
          collective: getEventData(collective1),
        });
        expect(result.errors).to.have.length(1);
        expect(result.errors[0].message).to.equal('You need to be logged in to create a collective');
      });

      it('fails if authenticated but cannot edit parent collective', async () => {
        await host.collective.update({ settings: { apply: true } });
        const result = await utils.graphqlQuery(
          createCollectiveMutation,
          { collective: getEventData(collective1) },
          user3,
        );
        expect(result.errors).to.have.length(1);
        expect(result.errors[0].message).to.equal(
          'You must be logged in as an admin of the scouts collective to create an account under it',
        );
      });

      it('fails if authenticated as a core contributor (MEMBER role) of the parent collective', async () => {
        await host.collective.update({ settings: { apply: true } });
        const coreContributor = await fakeUser();
        await collective1.addUserWithRole(coreContributor, roles.MEMBER);

        const result = await utils.graphqlQuery(
          createCollectiveMutation,
          { collective: getEventData(collective1) },
          coreContributor,
        );
        expect(result.errors).to.have.length(1);
        expect(result.errors[0].message).to.equal(
          'You must be logged in as an admin of the scouts collective to create an account under it',
        );

        // Same goes for projects
        const resultProject = await utils.graphqlQuery(
          createCollectiveMutation,
          {
            collective: {
              name: 'A project',
              type: 'PROJECT',
              slug: 'a-project-slug',
              ParentCollectiveId: collective1.id,
            },
          },
          coreContributor,
        );
        expect(resultProject.errors).to.have.length(1);
        expect(resultProject.errors[0].message).to.equal(
          'You must be logged in as an admin of the scouts collective to create an account under it',
        );
      });

      it('creates an event, uses the currency of parent collective and inherit fees', async () => {
        await host.collective.update({
          currency: 'CAD',
          settings: { apply: true },
          hostFeePercent: 10,
        });
        const event = getEventData(collective1);

        const result = await utils.graphqlQuery(createCollectiveMutation, { collective: event }, user1);
        result.errors && console.error(result.errors[0]);
        const createdEvent = result.data.createCollective;
        expect(createdEvent.slug).to.contain('brusselstogether-meetup');
        expect(createdEvent.hostFeePercent).to.equal(10);
        expect(createdEvent.isActive).to.be.true;
        event.id = createdEvent.id;

        // Make sure the creator of the event has been added as an ADMIN
        const members = await models.Member.findAll({
          where: { CollectiveId: event.id },
          order: [['MemberCollectiveId', 'ASC']],
        });
        expect(createdEvent.currency).to.equal(createdEvent.parentCollective.currency);
        expect(members).to.have.length(1);
        expect(members[0].role).to.equal(roles.HOST);
        expect(members[0].MemberCollectiveId).to.equal(collective1.HostCollectiveId);
        const updateQuery = gqlV1 /* GraphQL */ `
          mutation EditCollective($collective: CollectiveInputType!) {
            editCollective(collective: $collective) {
              id
              slug
            }
          }
        `;

        const r2 = await utils.graphqlQuery(updateQuery, { collective: event });
        expect(r2.errors).to.have.length(1);
        expect(r2.errors[0].message).to.equal('You need to be logged in to edit a collective');

        const r3 = await utils.graphqlQuery(updateQuery, { collective: event }, user3);
        expect(r3.errors).to.have.length(1);
        expect(r3.errors[0].message).to.equal(
          'You must be logged in as admin of the scouts collective to edit this Event.',
        );
      });
    });
  });

  describe('editCollective tests', () => {
    describe('sensitive settings guards', () => {
      const editCollectiveMutation = gqlV1 /* GraphQL */ `
        mutation EditCollective($collective: CollectiveInputType!) {
          editCollective(collective: $collective) {
            id
            settings
            tags
          }
        }
      `;

      const editSettingsMutationV2 = `
        mutation EditAccountSetting($account: AccountReferenceInput!, $key: AccountSettingsKey!, $value: JSON!) {
          editAccountSetting(account: $account, key: $key, value: $value) {
            id
            settings
          }
        }
      `;

      it('rejects payoutsTwoFactorAuth changes', async () => {
        const admin = await fakeUser();
        const testHost = await fakeActiveHost({
          admin,
          settings: {
            payoutsTwoFactorAuth: { enabled: true, rollingLimit: 10_000_00 },
          },
        });

        const v2Result = await utils.graphqlQueryV2(
          editSettingsMutationV2,
          {
            account: { legacyId: testHost.id },
            key: 'payoutsTwoFactorAuth',
            value: { enabled: true, rollingLimit: 999_999_00 },
          },
          admin,
        );
        expect(v2Result.errors).to.exist;
        expect(v2Result.errors[0].message).to.match(/two factor/i);

        await testHost.reload();
        const v1Result = await utils.graphqlQuery(
          editCollectiveMutation,
          {
            collective: {
              id: testHost.id,
              settings: {
                ...testHost.settings,
                payoutsTwoFactorAuth: { enabled: true, rollingLimit: 999_999_00 },
              },
            },
          },
          admin,
        );

        expect(v1Result.errors).to.exist;
        expect(v1Result.errors[0].message).to.match(/payoutsTwoFactorAuth.*cannot be edited via GraphQL v1/i);
        await testHost.reload();
        expect(testHost.settings.payoutsTwoFactorAuth.rollingLimit).to.eq(10_000_00);
      });

      it('rejects payoutsTwoFactorAuth removal', async () => {
        const admin = await fakeUser();
        const testHost = await fakeActiveHost({
          admin,
          settings: {
            payoutsTwoFactorAuth: { enabled: true, rollingLimit: 10_000_00 },
          },
        });

        // Can't remove
        const resultRemove = await utils.graphqlQuery(
          editCollectiveMutation,
          { collective: { id: testHost.id, settings: {} } },
          admin,
        );
        expect(resultRemove.errors).to.exist;
        expect(resultRemove.errors[0].message).to.match(/payoutsTwoFactorAuth.*cannot be edited via GraphQL v1/i);

        // Can't nullify
        const resultNull = await utils.graphqlQuery(
          editCollectiveMutation,
          { collective: { id: testHost.id, settings: null } },
          admin,
        );
        expect(resultNull.errors).to.exist;
        expect(resultNull.errors[0].message).to.match(/payoutsTwoFactorAuth.*cannot be edited via GraphQL v1/i);

        await testHost.reload();
        expect(testHost.settings.payoutsTwoFactorAuth.rollingLimit).to.eq(10_000_00);
      });

      it('still allows unrelated settings edits', async () => {
        const admin = await fakeUser();
        const collective = await fakeCollective({
          admin,
          tags: ['old'],
          settings: { payoutsTwoFactorAuth: { enabled: true, rollingLimit: 10_000_00 } },
        });

        const result = await utils.graphqlQuery(
          editCollectiveMutation,
          {
            collective: {
              id: collective.id,
              tags: ['new'],
              settings: {
                tos: 'https://example.com/tos',
                payoutsTwoFactorAuth: { enabled: true, rollingLimit: 10_000_00 },
              },
            },
          },
          admin,
        );

        expect(result.errors).to.not.exist;
        expect(result.data.editCollective.tags).to.deep.eq(['new']);
        expect(result.data.editCollective.settings.tos).to.eq('https://example.com/tos');
        expect(result.data.editCollective.settings.payoutsTwoFactorAuth.rollingLimit).to.eq(10_000_00);
      });
    });
  });

  describe('createOrder tests', () => {
    let localSandbox, metricsCountStub;

    // Enough card data for the fraud-protection card fingerprinting
    const fakeCreditCardPaymentMethodInput = () => ({
      service: 'stripe',
      type: 'creditcard',
      token: 'tok_visa',
      name: '4242',
      data: { expYear: 2030, expMonth: 12, brand: 'visa', fingerprint: 'fp_test' },
    });

    beforeEach(() => {
      localSandbox = createSandbox();
      localSandbox.stub(config, 'sentry').value({ dsn: 'https://sentry.io/123' });
      metricsCountStub = localSandbox.stub(SentrySdk.metrics, 'count');
    });

    afterEach(() => localSandbox.restore());

    it('records a failed payment outcome metric when a synchronous payment attempt fails', async () => {
      const hostAdmin = await fakeUser();
      const hostCollective = await fakeActiveHost({ currency: 'USD', admin: hostAdmin });
      const collective = await fakeCollective({ HostCollectiveId: hostCollective.id, currency: 'USD' });
      const user = await fakeUser();
      localSandbox
        .stub(creditcard, 'processOrder')
        .rejects(Object.assign(new Error('Your card was declined.'), { code: 'card_declined' }));

      await expect(
        createOrder(
          {
            collective: { id: collective.id },
            paymentMethod: fakeCreditCardPaymentMethodInput(),
            amount: 1000,
            quantity: 1,
            totalAmount: 1000,
            currency: 'USD',
          },
          utils.makeRequest(user),
        ),
      ).to.be.rejected;

      expect(metricsCountStub).to.have.been.calledOnce;
      expect(metricsCountStub.firstCall.args).to.deep.equal([
        'thirdparty.stripe.payment.failed',
        1,
        // eslint-disable-next-line camelcase
        { attributes: { flow: 'contribution', method: 'creditcard', error_type: 'card_declined' } },
      ]);

      const order = await models.Order.findOne({ where: { CollectiveId: collective.id } });
      expect(order.status).to.eq('ERROR');
    });

    it('does not record metrics when the payment requires client confirmation (3DS)', async () => {
      const hostAdmin = await fakeUser();
      const hostCollective = await fakeActiveHost({ currency: 'USD', admin: hostAdmin });
      const collective = await fakeCollective({ HostCollectiveId: hostCollective.id, currency: 'USD' });
      const user = await fakeUser();
      const threeDSError = Object.assign(new Error('Payment Intent require action'), {
        stripeResponse: { paymentIntent: { id: 'pi_3ds', status: 'requires_action' } },
      });
      localSandbox.stub(creditcard, 'processOrder').rejects(threeDSError);

      const result = await createOrder(
        {
          collective: { id: collective.id },
          paymentMethod: fakeCreditCardPaymentMethodInput(),
          amount: 1000,
          quantity: 1,
          totalAmount: 1000,
          currency: 'USD',
        },
        utils.makeRequest(user),
      );

      expect(result.stripeError).to.exist;
      expect(metricsCountStub.called).to.be.false;
      const order = await models.Order.findOne({ where: { CollectiveId: collective.id } });
      expect(order.status).to.eq('REQUIRE_CLIENT_CONFIRMATION');
    });

    it('rejects order with non-positive quantity', async () => {
      const user = await fakeUser();
      const collective = await fakeCollective();

      await expect(
        createOrder(
          {
            collective: { id: collective.id },
            amount: 1000,
            quantity: 0,
            totalAmount: 1000,
            currency: 'USD',
          },
          utils.makeRequest(user),
        ),
      ).to.be.rejectedWith('Quantity must be at least 1');

      await expect(
        createOrder(
          {
            collective: { id: collective.id },
            amount: 1000,
            quantity: -2,
            totalAmount: 1000,
            currency: 'USD',
          },
          utils.makeRequest(user),
        ),
      ).to.be.rejectedWith('Quantity must be at least 1');
    });

    it('rejects order with negative net amount for collective', async () => {
      const user = await fakeUser();
      const collective = await fakeCollective();

      await expect(
        createOrder(
          {
            collective: { id: collective.id },
            paymentMethod: fakeCreditCardPaymentMethodInput(),
            amount: 1000,
            quantity: 1,
            totalAmount: 500,
            platformTipAmount: 1000,
            currency: 'USD',
          },
          utils.makeRequest(user),
        ),
      ).to.be.rejectedWith('Invalid net amount for collective');
    });
  });
});
