import { expect } from 'chai';

import models, { sequelize } from '../../../server/models';
import { ManualPaymentProviderTypes } from '../../../server/models/ManualPaymentProvider';
import { fakeCollective, fakeOrder } from '../../test-helpers/fake-data';
import { resetTestDB } from '../../utils';

describe('server/models/ManualPaymentProvider', () => {
  before(async () => {
    await resetTestDB();
  });

  describe('validations', () => {
    it('accepts valid BANK_TRANSFER provider', async () => {
      const collective = await fakeCollective();
      const provider = await models.ManualPaymentProvider.create({
        CollectiveId: collective.id,
        type: ManualPaymentProviderTypes.BANK_TRANSFER,
        name: 'Wire Transfer',
        instructions: 'Please send payment to our bank account.',
        data: { bankName: 'Test Bank', accountNumber: '123456789' },
      });
      expect(provider.type).to.equal(ManualPaymentProviderTypes.BANK_TRANSFER);
      expect(provider.name).to.equal('Wire Transfer');
    });

    it('accepts valid OTHER provider', async () => {
      const collective = await fakeCollective();
      const provider = await models.ManualPaymentProvider.create({
        CollectiveId: collective.id,
        type: ManualPaymentProviderTypes.OTHER,
        name: 'Custom Payment',
        instructions: 'Contact us for payment details.',
      });
      expect(provider.type).to.equal(ManualPaymentProviderTypes.OTHER);
      expect(provider.name).to.equal('Custom Payment');
    });

    it('rejects provider with missing name', async () => {
      const collective = await fakeCollective();
      await expect(
        models.ManualPaymentProvider.create({
          CollectiveId: collective.id,
          type: ManualPaymentProviderTypes.BANK_TRANSFER,
          instructions: 'Some instructions',
        }),
      ).to.be.rejectedWith('notNull Violation');
    });

    it('rejects provider with empty name', async () => {
      const collective = await fakeCollective();
      await expect(
        models.ManualPaymentProvider.create({
          CollectiveId: collective.id,
          type: ManualPaymentProviderTypes.BANK_TRANSFER,
          name: '',
          instructions: 'Some instructions',
        }),
      ).to.be.rejectedWith('Name is required');
    });

    it('rejects provider with missing instructions', async () => {
      const collective = await fakeCollective();
      await expect(
        models.ManualPaymentProvider.create({
          CollectiveId: collective.id,
          type: ManualPaymentProviderTypes.BANK_TRANSFER,
          name: 'Test',
        }),
      ).to.be.rejectedWith('notNull Violation');
    });

    it('rejects provider with empty instructions', async () => {
      const collective = await fakeCollective();
      await expect(
        models.ManualPaymentProvider.create({
          CollectiveId: collective.id,
          type: ManualPaymentProviderTypes.BANK_TRANSFER,
          name: 'Test',
          instructions: '',
        }),
      ).to.be.rejectedWith('Instructions are required');
    });

    it('rejects provider with invalid type', async () => {
      const collective = await fakeCollective();
      await expect(
        models.ManualPaymentProvider.create({
          CollectiveId: collective.id,
          type: 'INVALID_TYPE',
          name: 'Test',
          instructions: 'Some instructions',
        }),
      ).to.be.rejectedWith('Must be one of');
    });

    it('accepts optional icon field', async () => {
      const collective = await fakeCollective();
      const provider = await models.ManualPaymentProvider.create({
        CollectiveId: collective.id,
        type: ManualPaymentProviderTypes.BANK_TRANSFER,
        name: 'Wire Transfer',
        instructions: 'Please send payment.',
        icon: 'Landmark',
      });
      expect(provider.icon).to.equal('Landmark');
    });

    it('sets default order to 0', async () => {
      const collective = await fakeCollective();
      const provider = await models.ManualPaymentProvider.create({
        CollectiveId: collective.id,
        type: ManualPaymentProviderTypes.BANK_TRANSFER,
        name: 'Wire Transfer',
        instructions: 'Please send payment.',
      });
      expect(provider.order).to.equal(0);
    });
  });

  describe('sanitization', () => {
    it('removes dangerous HTML tags like <script>', async () => {
      const collective = await fakeCollective();
      const provider = await models.ManualPaymentProvider.create({
        CollectiveId: collective.id,
        type: ManualPaymentProviderTypes.BANK_TRANSFER,
        name: 'Wire Transfer',
        instructions: '<p>Pay here</p><script>alert("xss")</script>',
      });
      expect(provider.instructions).to.equal('<p>Pay here</p>');
    });

    it('keeps safe HTML tags like <strong>, <em>, <a>', async () => {
      const collective = await fakeCollective();
      const provider = await models.ManualPaymentProvider.create({
        CollectiveId: collective.id,
        type: ManualPaymentProviderTypes.BANK_TRANSFER,
        name: 'Wire Transfer',
        instructions:
          '<p><strong>Important:</strong> Send <em>exact</em> amount to <a href="https://github.com/opencollective">this link</a></p>',
      });
      expect(provider.instructions).to.include('<strong>Important:</strong>');
      expect(provider.instructions).to.include('<em>exact</em>');
      expect(provider.instructions).to.include('href="https://github.com/opencollective"');
      expect(provider.instructions).to.include('<a ');
      expect(provider.instructions).to.include('this link</a>');
    });

    it('removes iframe tags', async () => {
      const collective = await fakeCollective();
      const provider = await models.ManualPaymentProvider.create({
        CollectiveId: collective.id,
        type: ManualPaymentProviderTypes.BANK_TRANSFER,
        name: 'Wire Transfer',
        instructions: '<p>Instructions</p><iframe src="https://evil.com"></iframe>',
      });
      expect(provider.instructions).to.equal('<p>Instructions</p>');
      expect(provider.instructions).to.not.include('iframe');
    });

    it('removes onclick and other event handlers', async () => {
      const collective = await fakeCollective();
      const provider = await models.ManualPaymentProvider.create({
        CollectiveId: collective.id,
        type: ManualPaymentProviderTypes.BANK_TRANSFER,
        name: 'Wire Transfer',
        instructions: '<p onclick="alert(1)">Click here</p>',
      });
      expect(provider.instructions).to.not.include('onclick');
    });

    it('preserves formatting tags like <ul>, <ol>, <li>', async () => {
      const collective = await fakeCollective();
      const provider = await models.ManualPaymentProvider.create({
        CollectiveId: collective.id,
        type: ManualPaymentProviderTypes.BANK_TRANSFER,
        name: 'Wire Transfer',
        instructions: '<ul><li>Step 1</li><li>Step 2</li></ul>',
      });
      expect(provider.instructions).to.include('<ul>');
      expect(provider.instructions).to.include('<li>');
    });

    it('preserves images', async () => {
      const collective = await fakeCollective();
      const provider = await models.ManualPaymentProvider.create({
        CollectiveId: collective.id,
        type: ManualPaymentProviderTypes.BANK_TRANSFER,
        name: 'Wire Transfer',
        instructions: '<p>Scan QR code:</p><img src="https://example.com/qr.png" alt="QR Code" />',
      });
      expect(provider.instructions).to.include('<img');
      expect(provider.instructions).to.include('src="https://example.com/qr.png"');
    });
  });

  describe('canBeDeleted', () => {
    it('returns true if no orders reference this provider', async () => {
      const collective = await fakeCollective();
      const provider = await models.ManualPaymentProvider.create({
        CollectiveId: collective.id,
        type: ManualPaymentProviderTypes.BANK_TRANSFER,
        name: 'Wire Transfer',
        instructions: 'Pay here.',
      });
      const result = await sequelize.transaction(async transaction => {
        return provider.canBeDeleted({ transaction });
      });
      expect(result).to.be.true;
    });

    it('returns false if orders reference this provider', async () => {
      const collective = await fakeCollective();
      const provider = await models.ManualPaymentProvider.create({
        CollectiveId: collective.id,
        type: ManualPaymentProviderTypes.BANK_TRANSFER,
        name: 'Wire Transfer',
        instructions: 'Pay here.',
      });
      await fakeOrder({ ManualPaymentProviderId: provider.id });
      const result = await sequelize.transaction(async transaction => {
        return provider.canBeDeleted({ transaction });
      });
      expect(result).to.be.false;
    });
  });

  describe('archive', () => {
    it('sets archivedAt to current timestamp', async () => {
      const collective = await fakeCollective();
      const provider = await models.ManualPaymentProvider.create({
        CollectiveId: collective.id,
        type: ManualPaymentProviderTypes.BANK_TRANSFER,
        name: 'Wire Transfer',
        instructions: 'Pay here.',
      });
      expect(provider.archivedAt).to.be.null;
      await sequelize.transaction(async transaction => {
        await provider.archive({ transaction });
      });
      expect(provider.archivedAt).to.be.instanceOf(Date);
    });
  });
});
