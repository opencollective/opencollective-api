import { expect } from 'chai';
import gqlV2 from 'fake-tag';

import OrderStatuses from '../../../../../server/constants/order_status';
import roles from '../../../../../server/constants/roles';
import { getTierFrequencyFromInterval } from '../../../../../server/graphql/v2/enum/TierFrequency';
import { idEncode, IDENTIFIER_TYPES } from '../../../../../server/graphql/v2/identifiers';
import models from '../../../../../server/models';
import { fakeCollective, fakeMember, fakeOrder, fakeTier, fakeUser } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB } from '../../../../utils';

const CREATE_TIER_MUTATION = gqlV2/* GraphQL */ `
  mutation CreateTierMutation($tier: TierCreateInput!, $account: AccountReferenceInput!) {
    createTier(tier: $tier, account: $account) {
      id
      legacyId
    }
  }
`;

const EDIT_TIER_MUTATION = gqlV2/* GraphQL */ `
  mutation EditTierMutation($tier: TierUpdateInput!) {
    editTier(tier: $tier) {
      id
      legacyId
      name
    }
  }
`;

const DELETE_TIER_MUTATION = gqlV2/* GraphQL */ `
  mutation DeleteTierMutation($tier: TierReferenceInput!, $stopRecurringContributions: Boolean) {
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
    existingTier = await fakeTier({ CollectiveId: collective.id });
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
      expect(result.errors).to.not.exist;
      expect(result.data.createTier.legacyId).to.exist;

      const createdTier = await models.Tier.findByPk(result.data.createTier.legacyId);
      expect(createdTier).to.exist;
    });
  });

  describe('editTierMutation', () => {
    let updateFields = {};
    before(() => {
      updateFields = {
        id: idEncode(existingTier.id, IDENTIFIER_TYPES.TIER),
        name: existingTier.name,
        type: existingTier.type,
        amountType: existingTier.amountType,
        frequency: getTierFrequencyFromInterval(existingTier.interval),
        amount: {
          value: existingTier.amount,
          currency: existingTier.currency,
        },
      };
    });

    it('validates if request user is logged in', async () => {
      const result = await graphqlQueryV2(EDIT_TIER_MUTATION, { tier: { ...updateFields, name: 'New name' } });
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You need to be logged in to manage account.');
    });

    it('validates if request user is not an admin', async () => {
      const result = await graphqlQueryV2(
        EDIT_TIER_MUTATION,
        { tier: { ...updateFields, name: 'New name' } },
        memberUser,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You need to be authenticated to perform this action');
    });

    it('validates request tier input', async () => {
      const result = await graphqlQueryV2(EDIT_TIER_MUTATION, { tier: {} }, adminUser);
      expect(result.errors).to.exist;
    });

    it('edited if request user is admin and tier input is valid', async () => {
      const result = await graphqlQueryV2(
        EDIT_TIER_MUTATION,
        { tier: { ...updateFields, name: 'New name' } },
        adminUser,
      );
      expect(result.errors).to.not.exist;
      expect(result.data.editTier.legacyId).to.exist;
      expect(result.data.editTier.name).to.equal('New name');

      const editedTier = await models.Tier.findByPk(result.data.editTier.legacyId);
      expect(editedTier).to.exist;
      expect(editedTier.name).to.equal('New name');
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
