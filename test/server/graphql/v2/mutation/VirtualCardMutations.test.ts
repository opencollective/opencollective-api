import { expect } from 'chai';
import gqlV2 from 'fake-tag';
import { createSandbox, match } from 'sinon';

import { frequencies } from '../../../../../server/constants/index.js';
import ActivityTypes from '../../../../../server/constants/activities.js';
import VirtualCardProviders from '../../../../../server/constants/virtual_card_providers.js';
import { VirtualCardLimitIntervals } from '../../../../../server/constants/virtual-cards.js';
import models from '../../../../../server/models/index.js';
import { VirtualCardStatus } from '../../../../../server/models/VirtualCard.js';
import * as stripeVirtualCards from '../../../../../server/paymentProviders/stripe/virtual-cards.js';
import { fakeCollective, fakeHost, fakeUser, fakeVirtualCard } from '../../../../test-helpers/fake-data.js';
import { graphqlQueryV2, resetTestDB } from '../../../../utils.js';

const DELETE_VIRTUAL_CARD_MUTATION = gqlV2/* GraphQL */ `
  mutation DeleteVirtualCard($virtualCard: VirtualCardReferenceInput!) {
    deleteVirtualCard(virtualCard: $virtualCard)
  }
`;

const EDIT_VIRTUAL_CARD_MUTATION = gqlV2/* GraphQL */ `
  mutation EditVirtualCard(
    $virtualCard: VirtualCardReferenceInput!
    $name: String
    $assignee: AccountReferenceInput
    $limitAmount: AmountInput
    $limitInterval: VirtualCardLimitInterval
  ) {
    editVirtualCard(
      virtualCard: $virtualCard
      name: $name
      assignee: $assignee
      limitAmount: $limitAmount
      limitInterval: $limitInterval
    ) {
      name
      assignee {
        legacyId
      }
      spendingLimitAmount
      spendingLimitInterval
    }
  }
`;

const CREATE_VIRTUAL_CARD_MUTATION = gqlV2/* GraphQL */ `
  mutation CreateVirtualCard(
    $name: String!
    $assignee: AccountReferenceInput!
    $account: AccountReferenceInput!
    $limitAmount: AmountInput!
    $limitInterval: VirtualCardLimitInterval!
  ) {
    createVirtualCard(
      name: $name
      assignee: $assignee
      account: $account
      limitAmount: $limitAmount
      limitInterval: $limitInterval
    ) {
      id
      name
      account {
        legacyId
      }
      assignee {
        legacyId
      }
      spendingLimitAmount
      spendingLimitInterval
    }
  }
`;

describe('server/graphql/v2/mutation/VirtualCardMutations', () => {
  describe('deleteVirtualCard', () => {
    let hostAdminUser, collectiveAdminUser, host, collective;
    let sandbox;

    beforeEach(resetTestDB);
    beforeEach(async () => {
      hostAdminUser = await fakeUser();
      collectiveAdminUser = await fakeUser();
      host = await fakeHost({ admin: hostAdminUser });
      collective = await fakeCollective({ HostCollectiveId: host.id, admin: collectiveAdminUser });
    });

    beforeEach(() => {
      sandbox = createSandbox();
    });
    afterEach(() => {
      sandbox.restore();
    });

    it('validates request user is authenticated', async () => {
      const result = await graphqlQueryV2(DELETE_VIRTUAL_CARD_MUTATION, { virtualCard: {} });
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You need to be logged in to manage virtual cards.');
    });

    it('validates request has permission to edit card', async () => {
      const virtualCard = await fakeVirtualCard({
        HostCollectiveId: host.id,
        CollectiveId: collective.id,
        provider: VirtualCardProviders.STRIPE,
      });

      const user = await fakeUser();
      const result = await graphqlQueryV2(
        DELETE_VIRTUAL_CARD_MUTATION,
        {
          virtualCard: {
            id: virtualCard.id,
          },
        },
        user,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal(`You don't have permission to edit this Virtual Card`);
    });

    it('validates virtual card exist', async () => {
      const result = await graphqlQueryV2(
        DELETE_VIRTUAL_CARD_MUTATION,
        {
          virtualCard: {
            id: 'does-not-exist',
          },
        },
        hostAdminUser,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Could not find Virtual Card');
    });

    it('deletes card using host admin', async () => {
      const virtualCard = await fakeVirtualCard({
        HostCollectiveId: host.id,
        CollectiveId: collective.id,
        provider: VirtualCardProviders.STRIPE,
      });

      sandbox.stub(stripeVirtualCards, 'deleteCard').resolves();

      const result = await graphqlQueryV2(
        DELETE_VIRTUAL_CARD_MUTATION,
        {
          virtualCard: {
            id: virtualCard.id,
          },
        },
        hostAdminUser,
      );
      expect(result.errors).to.not.exist;
      expect(result.data.deleteVirtualCard).to.equal(true);

      await virtualCard.reload();
      expect(virtualCard.data.status).to.eq(VirtualCardStatus.CANCELED);

      const activity = await models.Activity.findOne({
        where: { type: ActivityTypes.COLLECTIVE_VIRTUAL_CARD_DELETED },
      });
      expect(activity).to.exist;
      expect(activity.data.virtualCard.id).to.equal(virtualCard.id);
      expect(activity.data.deletedBy.id).to.equal(hostAdminUser.id);
    });

    it('deletes card using collective admin', async () => {
      const virtualCard = await fakeVirtualCard({
        HostCollectiveId: host.id,
        CollectiveId: collective.id,
        provider: VirtualCardProviders.STRIPE,
      });

      sandbox.stub(stripeVirtualCards, 'deleteCard').resolves();

      const result = await graphqlQueryV2(
        DELETE_VIRTUAL_CARD_MUTATION,
        {
          virtualCard: {
            id: virtualCard.id,
          },
        },
        collectiveAdminUser,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.deleteVirtualCard).to.equal(true);

      await virtualCard.reload();
      expect(virtualCard.data.status).to.eq(VirtualCardStatus.CANCELED);

      const activity = await models.Activity.findOne({
        where: { type: ActivityTypes.COLLECTIVE_VIRTUAL_CARD_DELETED },
      });
      expect(activity).to.exist;
      expect(activity.data.virtualCard.id).to.equal(virtualCard.id);
      expect(activity.data.deletedBy.id).to.equal(collectiveAdminUser.id);
    });
  });

  describe('editVirtualCard', () => {
    let hostAdminUser, collectiveAdminUser, host, collective;
    let sandbox;

    beforeEach(resetTestDB);
    beforeEach(async () => {
      hostAdminUser = await fakeUser();
      collectiveAdminUser = await fakeUser();
      host = await fakeHost({ admin: hostAdminUser });
      collective = await fakeCollective({ HostCollectiveId: host.id, admin: collectiveAdminUser });
    });

    beforeEach(() => {
      sandbox = createSandbox();
    });
    afterEach(() => {
      sandbox.restore();
    });

    it('requires authenticated user', async () => {
      const virtualCard = await fakeVirtualCard({
        HostCollectiveId: host.id,
        CollectiveId: collective.id,
        provider: VirtualCardProviders.STRIPE,
      });

      const result = await graphqlQueryV2(EDIT_VIRTUAL_CARD_MUTATION, {
        virtualCard: {
          id: virtualCard.id,
        },
        name: 'Test Virtual Card!',
      });

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You need to be logged in to manage virtual cards.');
    });

    it('fails to update name if user is not admin of card host or collective', async () => {
      const virtualCard = await fakeVirtualCard({
        HostCollectiveId: host.id,
        CollectiveId: collective.id,
        provider: VirtualCardProviders.STRIPE,
      });

      const user = await fakeUser();

      const result = await graphqlQueryV2(
        EDIT_VIRTUAL_CARD_MUTATION,
        {
          virtualCard: {
            id: virtualCard.id,
          },
          name: 'Test Virtual Card!',
        },
        user,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal(`You don't have permission to update this Virtual Card`);
    });

    it('edits virtual card name using host admin user', async () => {
      const virtualCard = await fakeVirtualCard({
        HostCollectiveId: host.id,
        CollectiveId: collective.id,
        provider: VirtualCardProviders.STRIPE,
      });

      const result = await graphqlQueryV2(
        EDIT_VIRTUAL_CARD_MUTATION,
        {
          virtualCard: {
            id: virtualCard.id,
          },
          name: 'Test Virtual Card!',
        },
        hostAdminUser,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.editVirtualCard.name).to.equal('Test Virtual Card!');

      await virtualCard.reload();
      expect(virtualCard.name).to.equal('Test Virtual Card!');
    });

    it('edits virtual card name using collective admin user', async () => {
      const virtualCard = await fakeVirtualCard({
        HostCollectiveId: host.id,
        CollectiveId: collective.id,
        provider: VirtualCardProviders.STRIPE,
      });

      const result = await graphqlQueryV2(
        EDIT_VIRTUAL_CARD_MUTATION,
        {
          virtualCard: {
            id: virtualCard.id,
          },
          name: 'Test Virtual Card!',
        },
        collectiveAdminUser,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.editVirtualCard.name).to.equal('Test Virtual Card!');

      await virtualCard.reload();
      expect(virtualCard.name).to.equal('Test Virtual Card!');
    });

    it('fails to update assignee if user is not admin of card host or collective', async () => {
      const virtualCard = await fakeVirtualCard({
        HostCollectiveId: host.id,
        CollectiveId: collective.id,
        provider: VirtualCardProviders.STRIPE,
      });

      const assignee = await fakeUser();
      const user = await fakeUser();

      const result = await graphqlQueryV2(
        EDIT_VIRTUAL_CARD_MUTATION,
        {
          virtualCard: {
            id: virtualCard.id,
          },
          assignee: {
            legacyId: assignee.collective.id,
          },
        },
        user,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal(`You don't have permission to update this Virtual Card`);
    });

    it('edits virtual card assignee using host admin user', async () => {
      const virtualCard = await fakeVirtualCard({
        HostCollectiveId: host.id,
        CollectiveId: collective.id,
        provider: VirtualCardProviders.STRIPE,
      });

      const assignee = await fakeUser();

      const result = await graphqlQueryV2(
        EDIT_VIRTUAL_CARD_MUTATION,
        {
          virtualCard: {
            id: virtualCard.id,
          },
          assignee: {
            legacyId: assignee.collective.id,
          },
        },
        hostAdminUser,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.editVirtualCard.assignee.legacyId).to.equal(assignee.collective.id);

      await virtualCard.reload();
      expect(virtualCard.UserId).to.equal(assignee.id);
    });

    it('edits virtual card assignee using collective admin user', async () => {
      const virtualCard = await fakeVirtualCard({
        HostCollectiveId: host.id,
        CollectiveId: collective.id,
        provider: VirtualCardProviders.STRIPE,
      });

      const assignee = await fakeUser();

      const result = await graphqlQueryV2(
        EDIT_VIRTUAL_CARD_MUTATION,
        {
          virtualCard: {
            id: virtualCard.id,
          },
          assignee: {
            legacyId: assignee.collective.id,
          },
        },
        collectiveAdminUser,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.editVirtualCard.assignee.legacyId).to.equal(assignee.collective.id);

      await virtualCard.reload();
      expect(virtualCard.UserId).to.equal(assignee.id);
    });

    it('fails to update limit if user is not admin of card host', async () => {
      const virtualCard = await fakeVirtualCard({
        HostCollectiveId: host.id,
        CollectiveId: collective.id,
        provider: VirtualCardProviders.STRIPE,
      });

      const result = await graphqlQueryV2(
        EDIT_VIRTUAL_CARD_MUTATION,
        {
          virtualCard: {
            id: virtualCard.id,
          },
          limitAmount: {
            valueInCents: 10000,
          },
          limitInterval: VirtualCardLimitIntervals.MONTHLY,
        },
        collectiveAdminUser,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal(`You don't have permission to update this Virtual Card's limit`);
    });

    it('validates limit is less than maximum monthly limit', async () => {
      const virtualCard = await fakeVirtualCard({
        HostCollectiveId: host.id,
        CollectiveId: collective.id,
        provider: VirtualCardProviders.STRIPE,
        spendingLimitInterval: frequencies.MONTHLY,
      });

      const result = await graphqlQueryV2(
        EDIT_VIRTUAL_CARD_MUTATION,
        {
          virtualCard: {
            id: virtualCard.id,
          },
          limitAmount: {
            valueInCents: 600000,
          },
          limitInterval: VirtualCardLimitIntervals.MONTHLY,
        },
        hostAdminUser,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal(`Limit for interval should not exceed 5000 USD`);
    });

    it('edits virtual card limit using host admin user', async () => {
      const virtualCard = await fakeVirtualCard({
        HostCollectiveId: host.id,
        CollectiveId: collective.id,
        provider: VirtualCardProviders.STRIPE,
        spendingLimitInterval: frequencies.MONTHLY,
      });

      sandbox.stub(stripeVirtualCards, 'updateVirtualCardLimit').resolves();

      const result = await graphqlQueryV2(
        EDIT_VIRTUAL_CARD_MUTATION,
        {
          virtualCard: {
            id: virtualCard.id,
          },
          limitAmount: {
            valueInCents: 150000,
          },
          limitInterval: VirtualCardLimitIntervals.MONTHLY,
        },
        hostAdminUser,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.editVirtualCard.spendingLimitAmount).to.equal(150000);
    });
  });

  describe('createVirtualCard', () => {
    let hostAdminUser, collectiveAdminUser, host, collective;
    let sandbox;

    beforeEach(resetTestDB);
    beforeEach(async () => {
      hostAdminUser = await fakeUser();
      collectiveAdminUser = await fakeUser();
      host = await fakeHost({ admin: hostAdminUser });
      collective = await fakeCollective({ HostCollectiveId: host.id, admin: collectiveAdminUser });
    });

    beforeEach(() => {
      sandbox = createSandbox();
    });
    afterEach(() => {
      sandbox.restore();
    });

    it('requires authenticated user', async () => {
      const result = await graphqlQueryV2(CREATE_VIRTUAL_CARD_MUTATION, {
        name: 'Test Virtual Card!',
        account: {
          legacyId: collective.id,
        },
        assignee: {
          legacyId: collectiveAdminUser.id,
        },
        limitAmount: {
          valueInCents: 50000,
        },
        limitInterval: VirtualCardLimitIntervals.MONTHLY,
      });

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You need to be logged in to manage virtual cards.');
    });

    it('fails to update name if user is not admin of host collective', async () => {
      const result = await graphqlQueryV2(
        CREATE_VIRTUAL_CARD_MUTATION,
        {
          name: 'Test Virtual Card!',
          account: {
            legacyId: collective.id,
          },
          assignee: {
            legacyId: collectiveAdminUser.id,
          },
          limitAmount: {
            valueInCents: 50000,
          },
          limitInterval: VirtualCardLimitIntervals.MONTHLY,
        },
        collectiveAdminUser,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal(`You don't have permission to edit this collective`);
    });

    it('creates virtual card using host admin user', async () => {
      sandbox
        .stub(stripeVirtualCards, 'createVirtualCard')
        .withArgs(
          match.has('id', host.id),
          match.has('id', collective.id),
          collectiveAdminUser.id,
          'Test Virtual Card!',
          50000,
          VirtualCardLimitIntervals.MONTHLY,
        )
        .resolves({
          id: 1,
          name: 'Test Virtual Card!',
          UserId: collectiveAdminUser.id,
          HostCollectiveId: host.id,
          CollectiveId: collective.id,
          spendingLimitAmount: 50000,
          spendingLimitInterval: VirtualCardLimitIntervals.MONTHLY,
          provider: VirtualCardProviders.STRIPE,
        });

      const result = await graphqlQueryV2(
        CREATE_VIRTUAL_CARD_MUTATION,
        {
          name: 'Test Virtual Card!',
          account: {
            legacyId: collective.id,
          },
          assignee: {
            legacyId: collectiveAdminUser.collective.id,
          },
          limitAmount: {
            valueInCents: 50000,
          },
          limitInterval: VirtualCardLimitIntervals.MONTHLY,
        },
        hostAdminUser,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.createVirtualCard.name).to.equal('Test Virtual Card!');
      expect(result.data.createVirtualCard.spendingLimitAmount).to.equal(50000);
      expect(result.data.createVirtualCard.spendingLimitInterval).to.equal(VirtualCardLimitIntervals.MONTHLY);
    });
  });
});
