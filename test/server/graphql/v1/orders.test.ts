import { expect } from 'chai';
import gqlV1 from 'fake-tag';
import { before, describe, it } from 'mocha';

import OrderStatuses from '../../../../server/constants/order-status';
import { fakeCollective, fakeOrder, fakePrivateOrganization, fakeUser } from '../../../test-helpers/fake-data';
import { createPrivateAccountFixture } from '../../../test-helpers/private-account-fixture';
import * as utils from '../../../utils';

const collectiveOrdersQuery = gqlV1 /* GraphQL */ `
  query CollectiveOrders($slug: String!, $status: OrderStatus) {
    Collective(slug: $slug) {
      id
      orders(status: $status) {
        id
        description
        status
        fromCollective {
          id
          slug
          isPrivate
        }
        collective {
          id
          slug
          isPrivate
        }
      }
    }
  }
`;

function expectPrivateAccountV1ForbiddenError(result) {
  expect(result.errors, `Expected errors but got: ${JSON.stringify(result.data)}`).to.have.length.greaterThan(0);
  const codes = result.errors.map(e => e.extensions?.code);
  expect(codes).to.include('Forbidden');
}

describe('server/graphql/v1/orders', () => {
  before(async () => {
    await utils.resetTestDB();
  });

  describe('Collective.orders', () => {
    let publicCollective, contributorUser, privateFromCollective;

    before(async () => {
      publicCollective = await fakeCollective();
      contributorUser = await fakeUser();
      privateFromCollective = await fakePrivateOrganization();

      await fakeOrder({
        CollectiveId: publicCollective.id,
        FromCollectiveId: contributorUser.CollectiveId,
        CreatedByUserId: contributorUser.id,
        processedAt: new Date(),
        description: 'Processed public contribution',
      });

      await fakeOrder({
        CollectiveId: publicCollective.id,
        FromCollectiveId: contributorUser.CollectiveId,
        CreatedByUserId: contributorUser.id,
        status: OrderStatuses.PENDING,
        processedAt: null,
        description: 'Unprocessed pending contribution',
      });

      await fakeOrder({
        CollectiveId: publicCollective.id,
        FromCollectiveId: privateFromCollective.id,
        CreatedByUserId: contributorUser.id,
        processedAt: new Date(),
        description: 'Contribution from private organization',
      });
    });

    it('returns only processed orders by default', async () => {
      const result = await utils.graphqlQuery(collectiveOrdersQuery, { slug: publicCollective.slug });
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;

      const descriptions = result.data.Collective.orders.map(o => o.description);
      expect(descriptions).to.eql(['Processed public contribution']);
    });

    it('returns orders matching status when status filter is provided', async () => {
      const result = await utils.graphqlQuery(collectiveOrdersQuery, {
        slug: publicCollective.slug,
        status: OrderStatuses.PENDING,
      });
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;

      const descriptions = result.data.Collective.orders.map(o => o.description);
      expect(descriptions).to.eql(['Unprocessed pending contribution']);
    });

    it('excludes orders from private organizations on public collectives', async () => {
      const result = await utils.graphqlQuery(collectiveOrdersQuery, { slug: publicCollective.slug });
      expect(result.errors).to.not.exist;

      const descriptions = result.data.Collective.orders.map(o => o.description);
      expect(descriptions).to.not.include('Contribution from private organization');
      expect(result.data.Collective.orders.every(o => !o.fromCollective.isPrivate)).to.be.true;
    });

    it('does not expose order.data on OrderType', async () => {
      const queryWithData = gqlV1 /* GraphQL */ `
        query CollectiveOrdersWithData($slug: String!) {
          Collective(slug: $slug) {
            orders {
              id
              data
            }
          }
        }
      `;

      const result = await utils.graphqlQuery(queryWithData, { slug: publicCollective.slug });
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.include('data');
    });
  });

  describe('Collective.orders - private organizations', () => {
    let ctx;

    before(async () => {
      await utils.resetTestDB();
      ctx = await createPrivateAccountFixture();

      await fakeOrder({
        CollectiveId: ctx.privateCollective.id,
        FromCollectiveId: ctx.randomUser.CollectiveId,
        CreatedByUserId: ctx.randomUser.id,
        processedAt: new Date(),
        description: 'Incoming order on private collective',
      });
    });

    describe('Collective query access', () => {
      it('returns Forbidden for unauthenticated users', async () => {
        const result = await utils.graphqlQuery(collectiveOrdersQuery, { slug: ctx.privateCollective.slug });
        expectPrivateAccountV1ForbiddenError(result);
      });

      it('returns Forbidden for random authenticated users', async () => {
        const result = await utils.graphqlQuery(
          collectiveOrdersQuery,
          { slug: ctx.privateCollective.slug },
          ctx.randomUser,
        );
        expectPrivateAccountV1ForbiddenError(result);
      });

      it('allows collective admin to resolve the collective', async () => {
        const result = await utils.graphqlQuery(
          collectiveOrdersQuery,
          { slug: ctx.privateCollective.slug },
          ctx.privateCollectiveAdmin,
        );
        expect(result.errors).to.be.undefined;
        expect(result.data.Collective.id).to.eq(ctx.privateCollective.id);
      });
    });

    describe('orders list hygiene on private collectives', () => {
      it('returns an empty list for collective admin (v1 never lists private-account orders)', async () => {
        const result = await utils.graphqlQuery(
          collectiveOrdersQuery,
          { slug: ctx.privateCollective.slug },
          ctx.privateCollectiveAdmin,
        );
        expect(result.errors).to.be.undefined;
        expect(result.data.Collective.orders).to.eql([]);
      });

      it('returns an empty list for host admin', async () => {
        const result = await utils.graphqlQuery(
          collectiveOrdersQuery,
          { slug: ctx.privateCollective.slug },
          ctx.privateHostAdmin,
        );
        expect(result.errors).to.be.undefined;
        expect(result.data.Collective.orders).to.eql([]);
      });
    });
  });
});
