import { expect } from 'chai';
import gql from 'fake-tag';
import { createSandbox, match } from 'sinon';

import { frequencies } from '../../../../../server/constants';
import ActivityTypes from '../../../../../server/constants/activities';
import VirtualCardProviders from '../../../../../server/constants/virtual-card-providers';
import { VirtualCardLimitIntervals } from '../../../../../server/constants/virtual-cards';
import models, { sequelize } from '../../../../../server/models';
import { VirtualCardStatus } from '../../../../../server/models/VirtualCard';
import * as stripeVirtualCards from '../../../../../server/paymentProviders/stripe/virtual-cards';
import {
  fakeCollective,
  fakeHost,
  fakeTransaction,
  fakeUser,
  fakeVirtualCard,
} from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB } from '../../../../utils';

const DELETE_VIRTUAL_CARD_MUTATION = gql`
  mutation DeleteVirtualCard($virtualCard: VirtualCardReferenceInput!) {
    deleteVirtualCard(virtualCard: $virtualCard)
  }
`;

const EDIT_VIRTUAL_CARD_MUTATION = gql`
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

const REQUEST_VIRTUAL_CARD_MUTATION = gql`
  mutation RequestVirtualCard($account: AccountReferenceInput!) {
    requestVirtualCard(
      account: $account
      purpose: "Test purpose"
      notes: "Test notes"
      spendingLimitAmount: { valueInCents: 50000 }
    )
  }
`;

const CREATE_VIRTUAL_CARD_MUTATION = gql`
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

const PAUSE_VIRTUAL_CARD_MUTATION = gql`
  mutation PauseVirtualCard($virtualCard: VirtualCardReferenceInput!) {
    pauseVirtualCard(virtualCard: $virtualCard) {
      id
      name
      last4
      status
    }
  }
`;

const RESUME_VIRTUAL_CARD_MUTATION = gql`
  mutation ResumeVirtualCard($virtualCard: VirtualCardReferenceInput!) {
    resumeVirtualCard(virtualCard: $virtualCard) {
      id
      name
      last4
      status
    }
  }
`;

const PRIVATE_CARD_DATA = { cardNumber: '4111111111114242', cvv: 'FAKESECRET_q3r4s5t6u7v8w9x0y1z2' };

const expectPublicVirtualCardSnapshot = (snapshot, virtualCard) => {
  expect(snapshot).to.include({
    id: virtualCard.id,
    name: virtualCard.name,
    last4: virtualCard.last4,
    provider: virtualCard.provider,
    CollectiveId: virtualCard.CollectiveId,
    HostCollectiveId: virtualCard.HostCollectiveId,
  });
  expect(snapshot).to.not.have.property('privateData');
  expect(snapshot).to.not.have.property('cardNumber');
  expect(snapshot).to.not.have.property('cvv');
};

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

  describe('requestVirtualCard', () => {
    let collectiveAdminUser, host, collective;

    beforeEach(resetTestDB);
    beforeEach(async () => {
      collectiveAdminUser = await fakeUser();
      host = await fakeHost({
        admin: await fakeUser(),
        settings: { virtualcards: { requestcard: true } },
      });
      collective = await fakeCollective({ HostCollectiveId: host.id, admin: collectiveAdminUser });
    });

    it('rejects when host disabled virtual card requests in settings', async () => {
      await host.update({
        settings: { ...host.settings, virtualcards: { ...host.settings?.virtualcards, requestcard: false } },
      });

      const result = await graphqlQueryV2(
        REQUEST_VIRTUAL_CARD_MUTATION,
        { account: { legacyId: collective.id } },
        collectiveAdminUser,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Virtual card requests are not available for this account');
      expect(await models.VirtualCardRequest.count()).to.equal(0);
    });

    it('rejects when collective has no balance', async () => {
      const result = await graphqlQueryV2(
        REQUEST_VIRTUAL_CARD_MUTATION,
        { account: { legacyId: collective.id } },
        collectiveAdminUser,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Virtual card requests are not available for this account');
      expect(await models.VirtualCardRequest.count()).to.equal(0);
    });

    it('creates a pending request when the feature is available', async () => {
      await fakeTransaction({
        type: 'CREDIT',
        CollectiveId: collective.id,
        HostCollectiveId: host.id,
        amount: 5000,
      });
      await sequelize.query(`REFRESH MATERIALIZED VIEW "TransactionBalances"`);
      await sequelize.query(`REFRESH MATERIALIZED VIEW "CollectiveBalanceCheckpoint"`);

      const result = await graphqlQueryV2(
        REQUEST_VIRTUAL_CARD_MUTATION,
        { account: { legacyId: collective.id } },
        collectiveAdminUser,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.requestVirtualCard).to.equal(true);

      const pending = await models.VirtualCardRequest.findOne({ where: { CollectiveId: collective.id } });
      expect(pending).to.exist;

      const activity = await models.Activity.findOne({ where: { type: ActivityTypes.VIRTUAL_CARD_REQUESTED } });
      expect(activity).to.exist;
    });
  });

  describe('pauseVirtualCard', () => {
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
      sandbox.stub(stripeVirtualCards, 'pauseCard').resolves();
    });
    afterEach(() => {
      sandbox.restore();
    });

    const createCard = (overrides = {}) =>
      fakeVirtualCard({
        HostCollectiveId: host.id,
        CollectiveId: collective.id,
        provider: VirtualCardProviders.STRIPE,
        name: 'Ops card',
        last4: '4242',
        privateData: PRIVATE_CARD_DATA,
        ...overrides,
      });

    it('requires authenticated user', async () => {
      const virtualCard = await createCard();
      const result = await graphqlQueryV2(PAUSE_VIRTUAL_CARD_MUTATION, { virtualCard: { id: virtualCard.id } });

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You need to be logged in to manage virtual cards.');
    });

    it('validates request has permission to pause card', async () => {
      const virtualCard = await createCard();
      const user = await fakeUser();
      const result = await graphqlQueryV2(PAUSE_VIRTUAL_CARD_MUTATION, { virtualCard: { id: virtualCard.id } }, user);

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal("You don't have permission to pause this Virtual Card");
    });

    it('validates virtual card exist', async () => {
      const result = await graphqlQueryV2(
        PAUSE_VIRTUAL_CARD_MUTATION,
        { virtualCard: { id: 'does-not-exist' } },
        hostAdminUser,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Could not find Virtual Card');
    });

    it('rejects pausing a canceled card', async () => {
      const virtualCard = await createCard({ data: { status: VirtualCardStatus.CANCELED } });
      const result = await graphqlQueryV2(
        PAUSE_VIRTUAL_CARD_MUTATION,
        { virtualCard: { id: virtualCard.id } },
        hostAdminUser,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('This Virtual Card cannot be paused');
    });

    it('pauses card using host admin and stores a public virtual card snapshot on the activity', async () => {
      const virtualCard = await createCard();
      const result = await graphqlQueryV2(
        PAUSE_VIRTUAL_CARD_MUTATION,
        { virtualCard: { id: virtualCard.id } },
        hostAdminUser,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.pauseVirtualCard.status).to.equal('INACTIVE');

      await virtualCard.reload();
      expect(virtualCard.data.status).to.eq(VirtualCardStatus.INACTIVE);
      expect(virtualCard.data.pauseReason).to.eq('MANUAL');

      const activity = await models.Activity.findOne({
        where: { type: ActivityTypes.COLLECTIVE_VIRTUAL_CARD_SUSPENDED },
      });
      expectPublicVirtualCardSnapshot(activity.data.virtualCard, virtualCard);
      expect(activity.UserId).to.equal(hostAdminUser.id);
    });

    it('pauses card using collective admin and does not persist privateData on the activity', async () => {
      const virtualCard = await createCard();
      const result = await graphqlQueryV2(
        PAUSE_VIRTUAL_CARD_MUTATION,
        { virtualCard: { id: virtualCard.id } },
        collectiveAdminUser,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.pauseVirtualCard.status).to.equal('INACTIVE');

      const activity = await models.Activity.findOne({
        where: { type: ActivityTypes.COLLECTIVE_VIRTUAL_CARD_SUSPENDED },
      });
      expectPublicVirtualCardSnapshot(activity.data.virtualCard, virtualCard);
      expect(activity.UserId).to.equal(collectiveAdminUser.id);
    });
  });

  describe('resumeVirtualCard', () => {
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
      sandbox.stub(stripeVirtualCards, 'resumeCard').resolves();
    });
    afterEach(() => {
      sandbox.restore();
    });

    const createPausedCard = (overrides = {}) =>
      fakeVirtualCard({
        HostCollectiveId: host.id,
        CollectiveId: collective.id,
        provider: VirtualCardProviders.STRIPE,
        name: 'Ops card',
        last4: '4242',
        privateData: PRIVATE_CARD_DATA,
        data: { status: VirtualCardStatus.INACTIVE, pauseReason: 'MANUAL' },
        ...overrides,
      });

    it('requires authenticated user', async () => {
      const virtualCard = await createPausedCard();
      const result = await graphqlQueryV2(RESUME_VIRTUAL_CARD_MUTATION, { virtualCard: { id: virtualCard.id } });

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You need to be logged in to manage virtual cards.');
    });

    it('rejects collective admin', async () => {
      const virtualCard = await createPausedCard();
      const result = await graphqlQueryV2(
        RESUME_VIRTUAL_CARD_MUTATION,
        { virtualCard: { id: virtualCard.id } },
        collectiveAdminUser,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal("You don't have permission to edit this Virtual Card");
    });

    it('validates virtual card exist', async () => {
      const result = await graphqlQueryV2(
        RESUME_VIRTUAL_CARD_MUTATION,
        { virtualCard: { id: 'does-not-exist' } },
        hostAdminUser,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Could not find Virtual Card');
    });

    it('rejects resuming a canceled card', async () => {
      const virtualCard = await createPausedCard({ data: { status: VirtualCardStatus.CANCELED } });
      const result = await graphqlQueryV2(
        RESUME_VIRTUAL_CARD_MUTATION,
        { virtualCard: { id: virtualCard.id } },
        hostAdminUser,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('This Virtual Card cannot be activated');
    });

    it('resumes card using host admin and stores a public virtual card snapshot on the activity', async () => {
      const virtualCard = await createPausedCard();
      const result = await graphqlQueryV2(
        RESUME_VIRTUAL_CARD_MUTATION,
        { virtualCard: { id: virtualCard.id } },
        hostAdminUser,
      );

      expect(result.errors).to.not.exist;
      expect(result.data.resumeVirtualCard.status).to.equal('ACTIVE');

      await virtualCard.reload();
      expect(virtualCard.data.status).to.eq(VirtualCardStatus.ACTIVE);
      expect(virtualCard.data).to.not.have.property('pauseReason');

      const activity = await models.Activity.findOne({
        where: { type: ActivityTypes.COLLECTIVE_VIRTUAL_CARD_RESUMED },
      });
      expectPublicVirtualCardSnapshot(activity.data.virtualCard, virtualCard);
      expect(activity.UserId).to.equal(hostAdminUser.id);
    });
  });
});
