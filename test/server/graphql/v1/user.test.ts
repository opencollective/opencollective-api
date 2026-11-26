import { expect } from 'chai';
import gql from 'fake-tag';
import { describe, it } from 'mocha';
import { createSandbox } from 'sinon';

import { createUser } from '../../../../server/graphql/common/user';
import { Collective, ConnectedAccount, Member, Order, PaymentMethod, User } from '../../../../server/models';
import creditcard from '../../../../server/paymentProviders/stripe/creditcard';
import { randEmail } from '../../../stores';
import { randStr } from '../../../test-helpers/fake-data';
import { data, graphqlQuery, graphqlQueryV2, resetTestDB } from '../../../utils';

const gqlV1 = gql;

const TIER_QUERY = gql`
  query Tier($id: Int!) {
    tier(tier: { legacyId: $id }) {
      id
      name
      orders {
        nodes {
          id
          description
          paymentMethod {
            name
          }
        }
      }
    }
  }
`;

const CREATE_ORDER_MUTATION = gql`
  mutation CreateOrder($order: OrderCreateInput!) {
    createOrder(order: $order) {
      order {
        paymentMethod {
          name
        }
        fromAccount {
          id
          legacyId
        }
        createdByAccount {
          id
          legacyId
          ... on Individual {
            email
          }
        }
      }
    }
  }
`;

const CREATE_USER_MUTATION = gql`
  mutation CreateUser($user: UserInputType!, $organization: CollectiveInputType, $throwIfExists: Boolean) {
    createUser(user: $user, organization: $organization, throwIfExists: $throwIfExists) {
      user {
        id
        email
      }
      organization {
        id
        slug
      }
    }
  }
`;

describe('server/graphql/v1/user', () => {
  let user1, user2, host, collective1, collective2, tier1, ticket1, sandbox;

  before(() => {
    sandbox = createSandbox();

    sandbox.stub(creditcard, 'processOrder').callsFake(order => {
      return Order.update({ processedAt: new Date() }, { where: { id: order.id } });
    });
  });

  after(() => sandbox.restore());

  beforeEach(() => resetTestDB());

  beforeEach(async () => {
    user1 = await User.createUserWithCollective(data('user1'));
  });
  beforeEach(async () => {
    user2 = await User.createUserWithCollective(data('user2'));
  });
  beforeEach(async () => {
    host = await User.createUserWithCollective(data('host1'));
  });

  beforeEach(async () => {
    collective1 = await Collective.create(data('collective1'));
  });

  beforeEach(async () => {
    collective2 = await Collective.create(data('collective2'));
  });

  beforeEach(async () => {
    tier1 = await collective1.createTier({ ...data('tier1'), interval: null });
  });
  beforeEach(async () => {
    ticket1 = await collective1.createTier(data('ticket1'));
  });

  beforeEach(() => collective1.addUserWithRole(user1, 'BACKER'));
  beforeEach(() => collective2.addUserWithRole(user1, 'ADMIN'));
  beforeEach(() => collective1.addHost(host.collective, host));

  beforeEach('create stripe account', () =>
    ConnectedAccount.create({
      service: 'stripe',
      token: 'abc',
      CollectiveId: host.id,
      username: 'stripeAccount',
    }),
  );

  describe('graphql.user.test.js', () => {
    describe('logged in user', () => {
      const loggedInUserQuery = gqlV1 /* GraphQL */ `
        query LoggedInUser {
          LoggedInUser {
            id
            memberOf {
              collective {
                slug
              }
              role
            }
          }
        }
      `;

      it('returns all collectives with role', async () => {
        const result = await graphqlQuery(loggedInUserQuery, null, user1);
        result.errors && console.error(result.errors);
        const data = result.data.LoggedInUser;
        expect(data.memberOf.length).to.equal(2);
        expect(data.memberOf[0].role).to.equal('BACKER');
        expect(data.memberOf[1].role).to.equal('ADMIN');
      });

      it("doesn't return anything if not logged in", async () => {
        const result = await graphqlQuery(loggedInUserQuery);
        result.errors && console.error(result.errors);
        const data = result.data.LoggedInUser;
        expect(data).to.be.null;
      });
    });

    describe('createUser', () => {
      it('creates a brand-new user and their organization for guests', async () => {
        const email = randEmail();
        const orgSlug = randStr('new-org-');

        const result = await graphqlQuery(CREATE_USER_MUTATION, {
          user: { name: 'New User', email },
          organization: { name: 'New Organization', slug: orgSlug },
        });

        result.errors && console.error(result.errors);
        expect(result.errors).to.not.exist;
        expect(result.data.createUser.organization.slug).to.equal(orgSlug);

        const organization = await Collective.findOne({ where: { slug: orgSlug } });
        const createdUser = await User.findOne({ where: { email } });
        expect(createdUser).to.exist;
        expect(result.data.createUser.user.id).to.equal(createdUser.id);
        expect(organization.CreatedByUserId).to.equal(createdUser.id);
        const [admin] = await organization.getMembers({ where: { role: 'ADMIN' } });
        expect(admin).to.exist;
        expect(admin.MemberCollectiveId).to.equal(createdUser.CollectiveId);
      });

      it('does not adopt an existing user when throwIfExists is false and the caller is not that user', async () => {
        const result = await graphqlQuery(CREATE_USER_MUTATION, {
          user: { email: user1.email },
          throwIfExists: false,
        });

        expect(result.errors).to.exist;
        expect(result.errors[0].extensions.code).to.equal('EMAIL_ALREADY_EXISTS');
        expect(result.data.createUser).to.be.null;
      });

      it('allows adopting an existing user in E2E environments (Cypress helper)', async () => {
        const previousE2ETest = process.env.E2E_TEST;
        process.env.E2E_TEST = '1';

        try {
          const result = await graphqlQuery(CREATE_USER_MUTATION, {
            user: { email: user1.email },
            throwIfExists: false,
          });

          expect(result.errors).to.not.exist;
          expect(result.data.createUser.user.id).to.equal(user1.id);
        } finally {
          if (previousE2ETest === undefined) {
            delete process.env.E2E_TEST;
          } else {
            process.env.E2E_TEST = previousE2ETest;
          }
        }
      });

      it('still refuses organizationData for a pre-existing user in E2E environments', async () => {
        const orgSlug = randStr('e2e-org-');
        const previousE2ETest = process.env.E2E_TEST;
        process.env.E2E_TEST = '1';

        try {
          const result = await graphqlQuery(CREATE_USER_MUTATION, {
            user: { email: user1.email },
            organization: { name: 'E2E Organization', slug: orgSlug },
            throwIfExists: false,
          });

          expect(result.errors).to.exist;
          expect(result.errors[0].extensions.code).to.equal('EMAIL_ALREADY_EXISTS');
          expect(await Collective.findOne({ where: { slug: orgSlug } })).to.not.exist;
        } finally {
          if (previousE2ETest === undefined) {
            delete process.env.E2E_TEST;
          } else {
            process.env.E2E_TEST = previousE2ETest;
          }
        }
      });

      it('does not adopt an existing user when throwIfExists is explicitly null', async () => {
        const result = await graphqlQuery(CREATE_USER_MUTATION, {
          user: { email: user1.email },
          throwIfExists: null,
        });

        expect(result.errors).to.exist;
        expect(result.errors[0].extensions.code).to.equal('EMAIL_ALREADY_EXISTS');
        expect(result.data.createUser).to.be.null;
      });

      it('does not create an organization bound to an existing user for guests', async () => {
        const orgSlug = randStr('victim-org-');
        const memberCount = await Member.count();

        const result = await graphqlQuery(CREATE_USER_MUTATION, {
          user: { email: user1.email },
          organization: { name: 'Victim Organization', slug: orgSlug },
          throwIfExists: false,
        });

        expect(result.errors).to.exist;
        expect(result.errors[0].extensions.code).to.equal('EMAIL_ALREADY_EXISTS');
        expect(await Collective.findOne({ where: { slug: orgSlug } })).to.not.exist;
        expect(await Member.count()).to.equal(memberCount);
      });

      it('does not create an organization for an existing user, even when authenticated as that user', async () => {
        const orgSlug = randStr('self-org-');

        const result = await graphqlQuery(
          CREATE_USER_MUTATION,
          {
            user: { email: user1.email },
            organization: { name: 'Self Organization', slug: orgSlug },
            throwIfExists: false,
          },
          user1,
        );

        expect(result.errors).to.exist;
        expect(result.errors[0].extensions.code).to.equal('EMAIL_ALREADY_EXISTS');
        expect(await Collective.findOne({ where: { slug: orgSlug } })).to.not.exist;
      });

      it('throws for an existing user when throwIfExists is omitted in the helper', async () => {
        try {
          await createUser(
            { name: 'Phil Mod', email: user1.email, newsletterOptIn: false, location: {} },
            { sendSignInLink: false },
          );
          expect.fail('Expected createUser to throw');
        } catch (error) {
          expect(error.extensions.code).to.equal('EMAIL_ALREADY_EXISTS');
        }
      });

      it('refuses organizationData for a pre-existing user in the helper', async () => {
        const orgSlug = randStr('helper-org-');

        try {
          await createUser(
            { name: 'Phil Mod', email: user1.email, newsletterOptIn: false, location: {} },
            {
              organizationData: { name: 'Helper Organization', slug: orgSlug },
              throwIfExists: false,
            },
          );
          expect.fail('Expected createUser to throw');
        } catch (error) {
          expect(error.extensions.code).to.equal('EMAIL_ALREADY_EXISTS');
        }

        expect(await Collective.findOne({ where: { slug: orgSlug } })).to.not.exist;
      });

      it('avoids slug conflict when autogenerated user slug matches organization slug', async () => {
        const orgSlug = randStr('economic-growth-');
        const email = randEmail();

        const { user, organization } = await createUser(
          {
            name: orgSlug.replace(/-/g, ' '),
            email,
            newsletterOptIn: false,
            location: {},
          },
          {
            organizationData: {
              name: 'Economic Growth NZ Inc.',
              slug: orgSlug,
            },
          },
        );

        expect(organization).to.exist;
        expect(organization.slug).to.equal(orgSlug);

        await user.collective.reload();
        expect(user.collective.slug).to.not.equal(orgSlug);
        expect(user.collective.slug).to.match(new RegExp(`^${orgSlug}-[a-zA-Z0-9]{8}$`));

        const [admin] = await organization.getMembers({ where: { role: 'ADMIN' } });
        expect(admin).to.exist;
        expect(admin.MemberCollectiveId).to.equal(user.CollectiveId);
      });
    });

    describe('payment methods', () => {
      const generateLoggedInOrder = (tier = tier1) => {
        return {
          paymentMethod: {
            service: 'STRIPE',
            name: '4242',
            isSavedForLater: true,
            creditCardInfo: { token: 'tok_visa' },
          },
          amount: { valueInCents: tier.amount ?? 1000, currency: 'USD' },
          frequency: 'ONETIME',
          toAccount: { legacyId: collective1.id },
          tier: { legacyId: tier.id },
        };
      };

      const generateLoggedOutOrder = (tier = tier1) => {
        return {
          ...generateLoggedInOrder(tier),
        };
      };

      it('saves a payment method to the user', async () => {
        const result = await graphqlQueryV2(CREATE_ORDER_MUTATION, { order: generateLoggedInOrder() }, user1);
        result.errors && console.error(result.errors);
        expect(result.errors).to.not.exist;
        const paymentMethods: PaymentMethod[] & { errors?: unknown } = await PaymentMethod.findAll({
          where: { CreatedByUserId: user1.id },
        });
        paymentMethods.errors && console.error(paymentMethods.errors);
        expect(paymentMethods).to.have.length(1);
        expect(paymentMethods[0].name).to.equal('4242');
        expect(paymentMethods[0].CollectiveId).to.equal(result.data.createOrder.order.fromAccount.legacyId);
      });

      it('does not save a payment method to the user', async () => {
        const order = generateLoggedInOrder();
        order.paymentMethod.isSavedForLater = false;
        const result = await graphqlQueryV2(CREATE_ORDER_MUTATION, { order }, user1);
        result.errors && console.error(result.errors);
        expect(result.errors).to.not.exist;
        const paymentMethods: PaymentMethod[] & { errors?: unknown } = await PaymentMethod.findAll({
          where: { CreatedByUserId: user1.id },
        });
        expect(paymentMethods).to.have.length(1);
        expect(paymentMethods[0].CollectiveId).to.be.eq(user1.CollectiveId);
        expect(paymentMethods[0].saved).to.be.null;
      });

      it("doesn't get the payment method of the user if not logged in", async () => {
        const remoteUser = await User.createUserWithCollective({
          email: randEmail('user@opencollective.com'),
        });
        const resultCreateOrder = await graphqlQueryV2(
          CREATE_ORDER_MUTATION,
          {
            order: generateLoggedOutOrder(ticket1),
          },
          remoteUser,
        );
        resultCreateOrder.errors && console.error(resultCreateOrder.errors);
        expect(resultCreateOrder.errors).to.not.exist;

        const result = await graphqlQueryV2(TIER_QUERY, { id: ticket1.id });
        result.errors && console.error(result.errors);
        const orders = result.data.tier.orders.nodes;
        expect(orders).to.have.length(1);
        expect(orders[0].paymentMethod).to.be.null;
        const result2 = await graphqlQueryV2(TIER_QUERY, { id: ticket1.id }, user2);
        result2.errors && console.error(result2.errors);
        const orders2 = result2.data.tier.orders.nodes;
        expect(orders2).to.have.length(1);
        expect(orders2[0].paymentMethod).to.be.null;
      });

      it('gets the payment method of the user if logged in as that user', async () => {
        const order = generateLoggedInOrder();
        await graphqlQueryV2(CREATE_ORDER_MUTATION, { order }, user1);
        await PaymentMethod.update({ confirmedAt: new Date() }, { where: { CreatedByUserId: user1.id } });

        const result = await graphqlQueryV2(TIER_QUERY, { id: tier1.id }, user1);
        result.errors && console.error(result.errors);
        const orders = result.data.tier.orders.nodes;
        expect(orders).to.have.length(1);
        expect(orders[0].paymentMethod.name).to.equal('4242');
      });
    });
  });
});
