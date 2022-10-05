import { expect } from 'chai';
import gqlV2 from 'fake-tag';
import { createSandbox } from 'sinon';

import ActivityTypes from '../../../../../server/constants/activities';
import VirtualCardProviders from '../../../../../server/constants/virtual_card_providers';
import models from '../../../../../server/models';
import * as stripeVirtualCards from '../../../../../server/paymentProviders/stripe/virtual-cards';
import { fakeCollective, fakeHost, fakeUser, fakeVirtualCard } from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB } from '../../../../utils';

const DELETE_VIRTUAL_CARD_MUTATION = gqlV2/* GraphQL */ `
  mutation DeleteVirtualCard($virtualCard: VirtualCardReferenceInput!) {
    deleteVirtualCard(virtualCard: $virtualCard)
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

      expect(await models.VirtualCard.findByPk(virtualCard.id)).to.not.exist;

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

      expect(await models.VirtualCard.findByPk(virtualCard.id)).to.not.exist;

      const activity = await models.Activity.findOne({
        where: { type: ActivityTypes.COLLECTIVE_VIRTUAL_CARD_DELETED },
      });
      expect(activity).to.exist;
      expect(activity.data.virtualCard.id).to.equal(virtualCard.id);
      expect(activity.data.deletedBy.id).to.equal(collectiveAdminUser.id);
    });
  });
});
