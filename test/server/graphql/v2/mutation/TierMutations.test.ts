import { expect } from 'chai';
import gql from 'fake-tag';

import OrderStatuses from '../../../../../server/constants/order_status';
import roles from '../../../../../server/constants/roles';
import { idEncode, IDENTIFIER_TYPES } from '../../../../../server/graphql/v2/identifiers';
import models from '../../../../../server/models';
import { fakeCollective, fakeMember, fakeOrder, fakeTier, fakeUser } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB } from '../../../../utils';

const CREATE_TIER_MUTATION = gql`
  mutation CreateTier($tier: TierCreateInput!, $account: AccountReferenceInput!) {
    createTier(tier: $tier, account: $account) {
      id
      legacyId
    }
  }
`;

const EDIT_TIER_MUTATION = gql`
  mutation EditTier($tier: TierUpdateInput!) {
    editTier(tier: $tier) {
      id
      legacyId
      name
    }
  }
`;

const DELETE_TIER_MUTATION = gql`
  mutation DeleteTier($tier: TierReferenceInput!, $stopRecurringContributions: Boolean) {
    deleteTier(tier: $tier, stopRecurringContributions: $stopRecurringContributions) {
      id
      legacyId
    }
  }
`;

const fakeTierCreateInput = {
  name: 'fake tier',
  type: 'TIER',
  amountType: 'FIXED',
  frequency: 'ONETIME',
  amount: {
    valueInCents: 1000,
    currency: 'USD',
  },
};

describe('server/graphql/v2/mutation/TierMutations', () => {
  let adminUser;
  let memberUser;
  let collective;
  let existingTier;

  before(resetTestDB);
  before(async () => {
    adminUser = await fakeUser();
    collective = await fakeCollective({ admin: adminUser });
    memberUser = await fakeUser();
    existingTier = await fakeTier({ CollectiveId: collective.id, minimumAmount: 42 });
    await fakeMember({ CollectiveId: memberUser.id, MemberCollectiveId: collective.id, role: roles.MEMBER });
  });

  describe('createTierMutation', () => {
    it('validates if request user is logged in', async () => {
      const result = await graphqlQueryV2(CREATE_TIER_MUTATION, {
        account: { legacyId: collective.id },
        tier: fakeTierCreateInput,
      });
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You need to be logged in to manage account.');
    });

    it('validates if request user is not an admin', async () => {
      const result = await graphqlQueryV2(
        CREATE_TIER_MUTATION,
        { account: { legacyId: collective.id }, tier: fakeTierCreateInput },
        memberUser,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You need to be authenticated to perform this action');
    });

    it('validates request tier input', async () => {
      const result = await graphqlQueryV2(
        CREATE_TIER_MUTATION,
        { account: { legacyId: collective.id }, tier: {} },
        adminUser,
      );
      expect(result.errors).to.exist;
    });

    it('created if request user is admin and tier input is valid', async () => {
      const result = await graphqlQueryV2(
        CREATE_TIER_MUTATION,
        { account: { legacyId: collective.id }, tier: fakeTierCreateInput },
        adminUser,
      );
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.createTier.legacyId).to.exist;

      const createdTier = await models.Tier.findByPk(result.data.createTier.legacyId);
      expect(createdTier).to.exist;
    });

    it('Always creates tier with collective currency', async () => {
      collective = await fakeCollective({ admin: adminUser, currency: 'EUR' });
      await fakeMember({ CollectiveId: memberUser.id, MemberCollectiveId: collective.id, role: roles.MEMBER });

      const result = await graphqlQueryV2(
        CREATE_TIER_MUTATION,
        {
          account: { legacyId: collective.id },
          tier: {
            name: 'fake tier',
            type: 'TIER',
            amountType: 'FIXED',
            frequency: 'ONETIME',
            amount: {
              valueInCents: 1000,
              currency: 'USD',
            },
          },
        },
        adminUser,
      );
      expect(result.errors).to.not.exist;
      expect(result.data.createTier.legacyId).to.exist;

      const createdTier = await models.Tier.findByPk(result.data.createTier.legacyId);
      expect(createdTier).to.exist;
      expect(createdTier.currency).to.eql('EUR');
    });
  });

  describe('editTierMutation', () => {
    let updateFields = {};
    before(() => {
      updateFields = {
        id: idEncode(existingTier.id, IDENTIFIER_TYPES.TIER),
        name: 'New name',
        singleTicket: true,
        invoiceTemplate: 'test-template',
      };
    });

    it('validates if request user is logged in', async () => {
      const result = await graphqlQueryV2(EDIT_TIER_MUTATION, { tier: updateFields });
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You need to be logged in to manage account.');
    });

    it('validates if request user is not an admin', async () => {
      const result = await graphqlQueryV2(EDIT_TIER_MUTATION, { tier: updateFields }, memberUser);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You need to be authenticated to perform this action');
    });

    it('validates request tier input', async () => {
      const result = await graphqlQueryV2(EDIT_TIER_MUTATION, { tier: {} }, adminUser);
      expect(result.errors).to.exist;
    });

    it('edited if request user is admin and tier input is valid', async () => {
      const result = await graphqlQueryV2(EDIT_TIER_MUTATION, { tier: updateFields }, adminUser);
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      expect(result.data.editTier.legacyId).to.exist;
      expect(result.data.editTier.name).to.equal('New name');

      const editedTier = await models.Tier.findByPk(result.data.editTier.legacyId);
      expect(editedTier).to.exist;
      expect(editedTier.name).to.equal('New name');
      expect(editedTier.data?.singleTicket).to.equal(true);
      expect(editedTier.data?.invoiceTemplate).to.equal('test-template');

      // Partial updates: other fields must not have changed
      expect(editedTier.minimumAmount).to.equal(42);
      expect(editedTier.interval).to.equal(existingTier.interval);
    });

    it('does not update tier currency', async () => {
      collective = await fakeCollective({ admin: adminUser, currency: 'EUR' });

      memberUser = await fakeUser();
      existingTier = await fakeTier({ CollectiveId: collective.id, minimumAmount: 42, currency: 'EUR' });
      await fakeMember({ CollectiveId: memberUser.id, MemberCollectiveId: collective.id, role: roles.MEMBER });

      const result = await graphqlQueryV2(
        EDIT_TIER_MUTATION,
        {
          tier: {
            id: idEncode(existingTier.id, IDENTIFIER_TYPES.TIER),
            name: 'New name',
            amount: {
              valueInCents: 5000,
              currency: 'USD',
            },
          },
        },
        adminUser,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.editTier.legacyId).to.exist;
      expect(result.data.editTier.name).to.equal('New name');

      const editedTier = await models.Tier.findByPk(result.data.editTier.legacyId);
      expect(editedTier).to.exist;
      expect(editedTier.name).to.equal('New name');

      // Partial updates: other fields must not have changed
      expect(editedTier.minimumAmount).to.equal(42);
      expect(editedTier.amount).to.equal(5000);
      expect(editedTier.currency).to.equal('EUR');
      expect(editedTier.interval).to.equal(existingTier.interval);
    });
  });

  describe('deleteTierMutation', () => {
    it('validates if request user is logged in', async () => {
      const result = await graphqlQueryV2(DELETE_TIER_MUTATION, { tier: { legacyId: existingTier.id } });
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You need to be logged in to manage account.');
    });

    it('validates if request user is not an admin', async () => {
      const result = await graphqlQueryV2(DELETE_TIER_MUTATION, { tier: { legacyId: existingTier.id } }, memberUser);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You need to be authenticated to perform this action');
    });

    it('validates request tier input', async () => {
      const result = await graphqlQueryV2(DELETE_TIER_MUTATION, { tier: {} }, adminUser);
      expect(result.errors).to.exist;
    });

    it('deleted if request user is admin and tier input is valid', async () => {
      const result = await graphqlQueryV2(DELETE_TIER_MUTATION, { tier: { legacyId: existingTier.id } }, adminUser);
      expect(result.errors).to.not.exist;
      expect(result.data.deleteTier.legacyId).to.exist;

      const editedTier = await models.Tier.findByPk(result.data.deleteTier.legacyId);
      expect(editedTier).to.not.exist;
    });

    it('deletes tier stopping recurring contributions', async () => {
      const tierWithRecurringContributions = await fakeTier({ CollectiveId: collective.id });
      const order = await fakeOrder(
        { status: OrderStatuses.ACTIVE, TierId: tierWithRecurringContributions.id },
        { withSubscription: true, withTransactions: true },
      );

      const result = await graphqlQueryV2(
        DELETE_TIER_MUTATION,
        { tier: { legacyId: tierWithRecurringContributions.id }, stopRecurringContributions: true },
        adminUser,
      );
      expect(result.errors).to.not.exist;
      expect(result.data.deleteTier.legacyId).to.exist;

      const editedTier = await models.Tier.findByPk(result.data.deleteTier.legacyId);
      expect(editedTier).to.not.exist;

      await order.reload();

      expect(order.status).to.equal(OrderStatuses.CANCELLED);
    });
  });
});
