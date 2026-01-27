import { expect } from 'chai';
import gql from 'fake-tag';

import { idEncode, IDENTIFIER_TYPES } from '../../../../../server/graphql/v2/identifiers';
import models from '../../../../../server/models';
import { ManualPaymentProviderTypes } from '../../../../../server/models/ManualPaymentProvider';
import {
  fakeActiveHost,
  fakeCollective,
  fakeManualPaymentProvider,
  fakeOrder,
  fakeUser,
} from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB } from '../../../../utils';

const CREATE_MANUAL_PAYMENT_PROVIDER_MUTATION = gql`
  mutation CreateManualPaymentProvider(
    $host: AccountReferenceInput!
    $manualPaymentProvider: ManualPaymentProviderCreateInput!
  ) {
    createManualPaymentProvider(host: $host, manualPaymentProvider: $manualPaymentProvider) {
      id
      type
      name
      instructions
      icon
      accountDetails
      isArchived
    }
  }
`;

const UPDATE_MANUAL_PAYMENT_PROVIDER_MUTATION = gql`
  mutation UpdateManualPaymentProvider(
    $manualPaymentProvider: ManualPaymentProviderReferenceInput!
    $input: ManualPaymentProviderUpdateInput!
  ) {
    updateManualPaymentProvider(manualPaymentProvider: $manualPaymentProvider, input: $input) {
      id
      type
      name
      instructions
      icon
      accountDetails
      isArchived
    }
  }
`;

const DELETE_MANUAL_PAYMENT_PROVIDER_MUTATION = gql`
  mutation DeleteManualPaymentProvider($manualPaymentProvider: ManualPaymentProviderReferenceInput!) {
    deleteManualPaymentProvider(manualPaymentProvider: $manualPaymentProvider) {
      id
      isArchived
    }
  }
`;

const REORDER_MANUAL_PAYMENT_PROVIDERS_MUTATION = gql`
  mutation ReorderManualPaymentProviders(
    $host: AccountReferenceInput!
    $type: ManualPaymentProviderType!
    $providers: [ManualPaymentProviderReferenceInput!]!
  ) {
    reorderManualPaymentProviders(host: $host, type: $type, providers: $providers) {
      id
      name
    }
  }
`;

describe('server/graphql/v2/mutation/ManualPaymentProviderMutations', () => {
  let host, hostAdmin, randomUser;

  before(async () => {
    await resetTestDB();
    hostAdmin = await fakeUser();
    host = await fakeActiveHost({ admin: hostAdmin });
    randomUser = await fakeUser();
  });

  describe('createManualPaymentProvider', () => {
    it('requires authentication', async () => {
      const result = await graphqlQueryV2(CREATE_MANUAL_PAYMENT_PROVIDER_MUTATION, {
        host: { legacyId: host.id },
        manualPaymentProvider: {
          type: 'BANK_TRANSFER',
          name: 'Test Provider',
          instructions: '<p>Transfer to our account</p>',
        },
      });

      expect(result.errors).to.exist;
      expect(result.errors[0].extensions.code).to.equal('Unauthorized');
    });

    it('requires host admin permission', async () => {
      const result = await graphqlQueryV2(
        CREATE_MANUAL_PAYMENT_PROVIDER_MUTATION,
        {
          host: { legacyId: host.id },
          manualPaymentProvider: {
            type: 'BANK_TRANSFER',
            name: 'Test Provider',
            instructions: '<p>Transfer to our account</p>',
          },
        },
        randomUser,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].extensions.code).to.equal('Unauthorized');
    });

    it('validates that account is a host', async () => {
      const collective = await fakeCollective();
      const collectiveAdmin = await fakeUser();
      await collective.addUserWithRole(collectiveAdmin, 'ADMIN');

      const result = await graphqlQueryV2(
        CREATE_MANUAL_PAYMENT_PROVIDER_MUTATION,
        {
          host: { legacyId: collective.id },
          manualPaymentProvider: {
            type: 'BANK_TRANSFER',
            name: 'Test Provider',
            instructions: '<p>Transfer to our account</p>',
          },
        },
        collectiveAdmin,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.include('Only hosts can have manual payment providers');
    });

    it('creates a manual payment provider', async () => {
      const result = await graphqlQueryV2(
        CREATE_MANUAL_PAYMENT_PROVIDER_MUTATION,
        {
          host: { legacyId: host.id },
          manualPaymentProvider: {
            type: 'BANK_TRANSFER',
            name: 'Wire Transfer',
            instructions: '<p>Please wire to our bank</p>',
            icon: 'Landmark',
            accountDetails: { bankName: 'Test Bank', accountNumber: '123456' },
          },
        },
        hostAdmin,
      );

      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;

      const provider = result.data.createManualPaymentProvider;
      expect(provider.type).to.equal('BANK_TRANSFER');
      expect(provider.name).to.equal('Wire Transfer');
      expect(provider.instructions).to.equal('<p>Please wire to our bank</p>');
      expect(provider.icon).to.equal('Landmark');
      expect(provider.accountDetails).to.deep.equal({ bankName: 'Test Bank', accountNumber: '123456' });
      expect(provider.isArchived).to.be.false;

      // Verify it was saved in the database
      const decodedId = IDENTIFIER_TYPES.MANUAL_PAYMENT_PROVIDER;
      const savedProvider = await models.ManualPaymentProvider.findOne({
        where: { CollectiveId: host.id, name: 'Wire Transfer' },
      });
      expect(savedProvider).to.exist;
      expect(savedProvider.type).to.equal('BANK_TRANSFER');
    });

    it('creates a provider with OTHER type', async () => {
      const result = await graphqlQueryV2(
        CREATE_MANUAL_PAYMENT_PROVIDER_MUTATION,
        {
          host: { legacyId: host.id },
          manualPaymentProvider: {
            type: 'OTHER',
            name: 'Cash Payment',
            instructions: '<p>Bring cash to our office</p>',
          },
        },
        hostAdmin,
      );

      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;

      const provider = result.data.createManualPaymentProvider;
      expect(provider.type).to.equal('OTHER');
      expect(provider.name).to.equal('Cash Payment');
    });

    it('increments order for new providers', async () => {
      const newHost = await fakeActiveHost({ admin: hostAdmin });

      // Create first provider
      await graphqlQueryV2(
        CREATE_MANUAL_PAYMENT_PROVIDER_MUTATION,
        {
          host: { legacyId: newHost.id },
          manualPaymentProvider: {
            type: 'BANK_TRANSFER',
            name: 'Provider 1',
            instructions: '<p>Instructions 1</p>',
          },
        },
        hostAdmin,
      );

      // Create second provider
      await graphqlQueryV2(
        CREATE_MANUAL_PAYMENT_PROVIDER_MUTATION,
        {
          host: { legacyId: newHost.id },
          manualPaymentProvider: {
            type: 'BANK_TRANSFER',
            name: 'Provider 2',
            instructions: '<p>Instructions 2</p>',
          },
        },
        hostAdmin,
      );

      const providers = await models.ManualPaymentProvider.findAll({
        where: { CollectiveId: newHost.id },
        order: [['order', 'ASC']],
      });

      expect(providers).to.have.length(2);
      expect(providers[0].name).to.equal('Provider 1');
      expect(providers[0].order).to.equal(1);
      expect(providers[1].name).to.equal('Provider 2');
      expect(providers[1].order).to.equal(2);
    });
  });

  describe('updateManualPaymentProvider', () => {
    let provider;

    before(async () => {
      provider = await fakeManualPaymentProvider({
        CollectiveId: host.id,
        name: 'Original Name',
        instructions: '<p>Original instructions</p>',
      });
    });

    it('requires authentication', async () => {
      const result = await graphqlQueryV2(UPDATE_MANUAL_PAYMENT_PROVIDER_MUTATION, {
        manualPaymentProvider: { id: idEncode(provider.id, IDENTIFIER_TYPES.MANUAL_PAYMENT_PROVIDER) },
        input: { name: 'Updated Name' },
      });

      expect(result.errors).to.exist;
      expect(result.errors[0].extensions.code).to.equal('Unauthorized');
    });

    it('requires host admin permission', async () => {
      const result = await graphqlQueryV2(
        UPDATE_MANUAL_PAYMENT_PROVIDER_MUTATION,
        {
          manualPaymentProvider: { id: idEncode(provider.id, IDENTIFIER_TYPES.MANUAL_PAYMENT_PROVIDER) },
          input: { name: 'Updated Name' },
        },
        randomUser,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].extensions.code).to.equal('Forbidden');
    });

    it('cannot update an archived provider', async () => {
      const archivedProvider = await fakeManualPaymentProvider({
        CollectiveId: host.id,
        archivedAt: new Date(),
      });

      const result = await graphqlQueryV2(
        UPDATE_MANUAL_PAYMENT_PROVIDER_MUTATION,
        {
          manualPaymentProvider: { id: idEncode(archivedProvider.id, IDENTIFIER_TYPES.MANUAL_PAYMENT_PROVIDER) },
          input: { name: 'New Name' },
        },
        hostAdmin,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.include('Cannot update an archived manual payment provider');
    });

    it('updates provider fields', async () => {
      const result = await graphqlQueryV2(
        UPDATE_MANUAL_PAYMENT_PROVIDER_MUTATION,
        {
          manualPaymentProvider: { id: idEncode(provider.id, IDENTIFIER_TYPES.MANUAL_PAYMENT_PROVIDER) },
          input: {
            name: 'Updated Name',
            instructions: '<p>Updated instructions</p>',
            icon: 'CreditCard',
            accountDetails: { newField: 'newValue' },
          },
        },
        hostAdmin,
      );

      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;

      const updated = result.data.updateManualPaymentProvider;
      expect(updated.name).to.equal('Updated Name');
      expect(updated.instructions).to.equal('<p>Updated instructions</p>');
      expect(updated.icon).to.equal('CreditCard');
      expect(updated.accountDetails).to.deep.equal({ newField: 'newValue' });
    });

    it('allows partial updates', async () => {
      const testProvider = await fakeManualPaymentProvider({
        CollectiveId: host.id,
        name: 'Test Provider',
        instructions: '<p>Test instructions</p>',
        icon: 'Landmark',
      });

      const result = await graphqlQueryV2(
        UPDATE_MANUAL_PAYMENT_PROVIDER_MUTATION,
        {
          manualPaymentProvider: { id: idEncode(testProvider.id, IDENTIFIER_TYPES.MANUAL_PAYMENT_PROVIDER) },
          input: { name: 'Only Name Changed' },
        },
        hostAdmin,
      );

      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;

      const updated = result.data.updateManualPaymentProvider;
      expect(updated.name).to.equal('Only Name Changed');
      expect(updated.instructions).to.equal('<p>Test instructions</p>');
      expect(updated.icon).to.equal('Landmark');
    });
  });

  describe('deleteManualPaymentProvider', () => {
    it('requires authentication', async () => {
      const provider = await fakeManualPaymentProvider({ CollectiveId: host.id });

      const result = await graphqlQueryV2(DELETE_MANUAL_PAYMENT_PROVIDER_MUTATION, {
        manualPaymentProvider: { id: idEncode(provider.id, IDENTIFIER_TYPES.MANUAL_PAYMENT_PROVIDER) },
      });

      expect(result.errors).to.exist;
      expect(result.errors[0].extensions.code).to.equal('Unauthorized');
    });

    it('requires host admin permission', async () => {
      const provider = await fakeManualPaymentProvider({ CollectiveId: host.id });

      const result = await graphqlQueryV2(
        DELETE_MANUAL_PAYMENT_PROVIDER_MUTATION,
        {
          manualPaymentProvider: { id: idEncode(provider.id, IDENTIFIER_TYPES.MANUAL_PAYMENT_PROVIDER) },
        },
        randomUser,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].extensions.code).to.equal('Forbidden');
    });

    it('deletes provider when no orders reference it', async () => {
      const provider = await fakeManualPaymentProvider({ CollectiveId: host.id });

      const result = await graphqlQueryV2(
        DELETE_MANUAL_PAYMENT_PROVIDER_MUTATION,
        {
          manualPaymentProvider: { id: idEncode(provider.id, IDENTIFIER_TYPES.MANUAL_PAYMENT_PROVIDER) },
        },
        hostAdmin,
      );

      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;

      // Verify it was deleted (soft delete)
      const deletedProvider = await models.ManualPaymentProvider.findByPk(provider.id);
      expect(deletedProvider).to.be.null;
    });

    it('archives provider when orders reference it', async () => {
      const provider = await fakeManualPaymentProvider({ CollectiveId: host.id });

      // Create an order that references this provider
      const collective = await fakeCollective({ HostCollectiveId: host.id });
      await fakeOrder({ CollectiveId: collective.id, ManualPaymentProviderId: provider.id });

      const result = await graphqlQueryV2(
        DELETE_MANUAL_PAYMENT_PROVIDER_MUTATION,
        {
          manualPaymentProvider: { id: idEncode(provider.id, IDENTIFIER_TYPES.MANUAL_PAYMENT_PROVIDER) },
        },
        hostAdmin,
      );

      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;

      expect(result.data.deleteManualPaymentProvider.isArchived).to.be.true;

      // Verify it was archived, not deleted
      const archivedProvider = await models.ManualPaymentProvider.findByPk(provider.id);
      expect(archivedProvider).to.exist;
      expect(archivedProvider.archivedAt).to.not.be.null;
    });
  });

  describe('reorderManualPaymentProviders', () => {
    let provider1, provider2, provider3;

    before(async () => {
      // Create providers in order
      provider1 = await fakeManualPaymentProvider({
        CollectiveId: host.id,
        type: ManualPaymentProviderTypes.BANK_TRANSFER,
        name: 'Provider A',
        order: 0,
      });
      provider2 = await fakeManualPaymentProvider({
        CollectiveId: host.id,
        type: ManualPaymentProviderTypes.BANK_TRANSFER,
        name: 'Provider B',
        order: 1,
      });
      provider3 = await fakeManualPaymentProvider({
        CollectiveId: host.id,
        type: ManualPaymentProviderTypes.BANK_TRANSFER,
        name: 'Provider C',
        order: 2,
      });
    });

    it('requires authentication', async () => {
      const result = await graphqlQueryV2(REORDER_MANUAL_PAYMENT_PROVIDERS_MUTATION, {
        host: { legacyId: host.id },
        type: 'BANK_TRANSFER',
        providers: [
          { id: idEncode(provider3.id, IDENTIFIER_TYPES.MANUAL_PAYMENT_PROVIDER) },
          { id: idEncode(provider1.id, IDENTIFIER_TYPES.MANUAL_PAYMENT_PROVIDER) },
          { id: idEncode(provider2.id, IDENTIFIER_TYPES.MANUAL_PAYMENT_PROVIDER) },
        ],
      });

      expect(result.errors).to.exist;
      expect(result.errors[0].extensions.code).to.equal('Unauthorized');
    });

    it('requires host admin permission', async () => {
      const result = await graphqlQueryV2(
        REORDER_MANUAL_PAYMENT_PROVIDERS_MUTATION,
        {
          host: { legacyId: host.id },
          type: 'BANK_TRANSFER',
          providers: [
            { id: idEncode(provider3.id, IDENTIFIER_TYPES.MANUAL_PAYMENT_PROVIDER) },
            { id: idEncode(provider1.id, IDENTIFIER_TYPES.MANUAL_PAYMENT_PROVIDER) },
            { id: idEncode(provider2.id, IDENTIFIER_TYPES.MANUAL_PAYMENT_PROVIDER) },
          ],
        },
        randomUser,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].extensions.code).to.equal('Forbidden');
    });

    it('reorders providers', async () => {
      const result = await graphqlQueryV2(
        REORDER_MANUAL_PAYMENT_PROVIDERS_MUTATION,
        {
          host: { legacyId: host.id },
          type: 'BANK_TRANSFER',
          providers: [
            { id: idEncode(provider3.id, IDENTIFIER_TYPES.MANUAL_PAYMENT_PROVIDER) },
            { id: idEncode(provider1.id, IDENTIFIER_TYPES.MANUAL_PAYMENT_PROVIDER) },
            { id: idEncode(provider2.id, IDENTIFIER_TYPES.MANUAL_PAYMENT_PROVIDER) },
          ],
        },
        hostAdmin,
      );

      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;

      // Reload providers and verify new order
      await provider1.reload();
      await provider2.reload();
      await provider3.reload();

      expect(provider3.order).to.equal(0);
      expect(provider1.order).to.equal(1);
      expect(provider2.order).to.equal(2);
    });
  });
});
