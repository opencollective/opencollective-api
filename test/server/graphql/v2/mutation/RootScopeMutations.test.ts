import { expect } from 'chai';
import gql from 'fake-tag';

import { roles } from '../../../../../server/constants';
import { CollectiveType } from '../../../../../server/constants/collectives';
import OrderStatuses from '../../../../../server/constants/order-status';
import { canMarkAsUnpaid, checkCanCreateExpenseForCollective } from '../../../../../server/graphql/common/expenses';
import { canAddFundsFromAccount, canCancelOrder } from '../../../../../server/graphql/common/orders';
import {
  fakeActiveHost,
  fakeCollective,
  fakeExpense,
  fakeHost,
  fakeMember,
  fakeOrder,
  fakeUser,
  fakeUserToken,
} from '../../../../test-helpers/fake-data';
import { getOrCreatePlatformAccount, makeRequest, oAuthGraphqlQueryV2 } from '../../../../utils';

describe('GraphQL v2 mutation root scope', () => {
  let root;

  before(async () => {
    const platform = await getOrCreatePlatformAccount();
    root = await fakeUser({ data: { isRoot: true } });
    await fakeMember({ CollectiveId: platform.id, MemberCollectiveId: root.CollectiveId, role: roles.ADMIN });
    await root.populateRoles();
    expect(root.isRoot()).to.be.true;
  });

  const expectRootScopeError = result => {
    expect(result.errors).to.not.be.empty;
    expect(result.errors[0].extensions.code).to.equal('Forbidden');
    expect(result.errors[0].message).to.equal('The User Token is not allowed for operations in scope "root".');
  };

  for (const [mutation, query] of [
    [
      'editOrganizationMoneyManagementAndHosting',
      gql`
        mutation Update($organization: AccountReferenceInput!) {
          editOrganizationMoneyManagementAndHosting(organization: $organization) {
            id
          }
        }
      `,
    ],
    [
      'convertOrganizationToCollective',
      gql`
        mutation Convert($organization: AccountReferenceInput!) {
          convertOrganizationToCollective(organization: $organization) {
            id
          }
        }
      `,
    ],
  ]) {
    it(`requires root scope for ${mutation} on an unrelated organization`, async () => {
      const organization = await fakeCollective({ type: CollectiveType.ORGANIZATION, admin: await fakeUser() });
      expectRootScopeError(
        await oAuthGraphqlQueryV2(
          query,
          { organization: { legacyId: organization.id } },
          await fakeUserToken({ user: root, scope: ['account'] }),
        ),
      );
      expect((await organization.reload()).type).to.equal(CollectiveType.ORGANIZATION);
    });
  }

  it('requires root scope to update an unrelated recurring order', async () => {
    const order = await fakeOrder({}, { withSubscription: true });
    expectRootScopeError(
      await oAuthGraphqlQueryV2(
        gql`
          mutation Update($order: OrderReferenceInput!) {
            updateOrder(order: $order) {
              id
            }
          }
        `,
        { order: { id: order.publicId } },
        await fakeUserToken({ user: root, scope: ['orders'] }),
      ),
    );
  });

  it('requires root scope for a host admin to create pending orders from unrelated accounts', async () => {
    const host = await fakeHost({ admin: root });
    const collective = await fakeCollective({ HostCollectiveId: host.id });
    const contributor = await fakeUser();
    expectRootScopeError(
      await oAuthGraphqlQueryV2(
        gql`
          mutation Create($order: PendingOrderCreateInput!) {
            createPendingOrder(order: $order) {
              id
            }
          }
        `,
        {
          order: {
            fromAccount: { legacyId: contributor.CollectiveId },
            toAccount: { legacyId: collective.id },
            amount: { valueInCents: 1000, currency: collective.currency },
          },
        },
        await fakeUserToken({ user: root, scope: ['orders'] }),
      ),
    );
  });

  it('requires root scope to add funds from unrelated accounts, preserving normal host-admin access', async () => {
    const host = await fakeHost({ admin: root });
    const unrelatedAccount = await fakeCollective();
    const hostedAccount = await fakeCollective({ HostCollectiveId: host.id });
    await root.populateRoles();
    const token = await fakeUserToken({ user: root, scope: ['host'] });
    const req = makeRequest(root, undefined, undefined, {}, token);

    expect(canAddFundsFromAccount(unrelatedAccount, host, req)).to.not.be.ok;
    expect(canAddFundsFromAccount(hostedAccount, host, req)).to.be.true;
    await token.update({ scope: ['host', 'root'] });
    expect(canAddFundsFromAccount(unrelatedAccount, host, req)).to.be.true;
  });

  it('requires root scope to cancel an unrelated recurring order', async () => {
    const order = await fakeOrder({}, { withSubscription: true });
    const token = await fakeUserToken({ user: root, scope: ['orders'] });
    const req = makeRequest(root, undefined, undefined, {}, token);

    expect(await canCancelOrder(req, order)).to.be.false;
    await token.update({ scope: ['orders', 'root'] });
    expect(await canCancelOrder(req, order)).to.be.true;
  });

  it('requires root scope to edit pending orders with unrelated source accounts', async () => {
    const host = await fakeActiveHost({ admin: root, plan: 'start-plan-2021' });
    const collective = await fakeCollective({ HostCollectiveId: host.id });
    const order = await fakeOrder({
      CollectiveId: collective.id,
      status: OrderStatuses.PENDING,
      data: { isPendingContribution: true },
    });
    const contributor = await fakeUser();
    expectRootScopeError(
      await oAuthGraphqlQueryV2(
        gql`
          mutation Edit($order: PendingOrderEditInput!) {
            editPendingOrder(order: $order) {
              id
            }
          }
        `,
        {
          order: {
            id: order.publicId,
            fromAccount: { legacyId: contributor.CollectiveId },
            amount: { valueInCents: 1000, currency: collective.currency },
          },
        },
        await fakeUserToken({ user: root, scope: ['orders'] }),
      ),
    );
    expect((await order.reload()).FromCollectiveId).to.not.equal(contributor.CollectiveId);
  });

  it('requires root scope to mark a virtual card charge as unpaid', async () => {
    const host = await fakeHost({ admin: root });
    const collective = await fakeCollective({ HostCollectiveId: host.id });
    const expense = await fakeExpense({ CollectiveId: collective.id, type: 'CHARGE', status: 'PAID' });
    await root.populateRoles();
    const token = await fakeUserToken({ user: root, scope: ['expenses'] });
    const req = makeRequest(root, undefined, undefined, {}, token);

    expect(await canMarkAsUnpaid(req, expense)).to.be.false;
    await token.update({ scope: ['expenses', 'root'] });
    expect(await canMarkAsUnpaid(req, expense)).to.be.true;
  });

  it('requires root scope to bypass disabled public expense submissions', async () => {
    const collective = await fakeCollective({ settings: { disablePublicExpenseSubmission: true } });
    const token = await fakeUserToken({ user: root, scope: ['expenses'] });
    const req = makeRequest(root, undefined, undefined, {}, token);

    expect(() => checkCanCreateExpenseForCollective(collective, req)).to.throw(
      'The User Token is not allowed for operations in scope "root".',
    );
    await token.update({ scope: ['expenses', 'root'] });
    expect(() => checkCanCreateExpenseForCollective(collective, req)).to.not.throw();
  });
});
