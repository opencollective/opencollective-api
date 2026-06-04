import { expect } from 'chai';

// @ts-expect-error - migration is a default export
import migration from '../../migrations/20260602120000-nest-manual-payment-provider-account-details'; // eslint-disable-line import/default
import models, { sequelize } from '../../server/models';
import { ManualPaymentProviderTypes } from '../../server/models/ManualPaymentProvider';
import { fakeActiveHost, fakeManualPaymentProvider } from '../test-helpers/fake-data';
import { resetTestDB } from '../utils';

describe('migrations/20260602120000-nest-manual-payment-provider-account-details', () => {
  beforeEach(async () => {
    await resetTestDB();
  });

  it('nests legacy account details under data.accountDetails', async () => {
    const host = await fakeActiveHost();
    await models.ManualPaymentProvider.create({
      CollectiveId: host.id,
      type: ManualPaymentProviderTypes.BANK_TRANSFER,
      name: 'Bank Transfer',
      instructions: 'Instructions',
      // @ts-expect-error using the legacy data format
      data: { bankName: 'Legacy Bank', accountNumber: '123456' },
    });

    await migration.up(sequelize.getQueryInterface());

    const provider = await models.ManualPaymentProvider.findOne({
      where: { CollectiveId: host.id, name: 'Bank Transfer' },
    });

    expect(provider.data).to.deep.equal({
      accountDetails: {
        bankName: 'Legacy Bank',
        accountNumber: '123456',
      },
    });
  });

  it('leaves rows that already use data.accountDetails unchanged', async () => {
    const host = await fakeActiveHost();
    await fakeManualPaymentProvider({
      CollectiveId: host.id,
      data: { accountDetails: { bankName: 'Nested Bank' } },
    });

    await migration.up(sequelize.getQueryInterface());

    const provider = await models.ManualPaymentProvider.findOne({ where: { CollectiveId: host.id } });

    expect(provider.data).to.deep.equal({
      accountDetails: {
        bankName: 'Nested Bank',
      },
    });
  });
});
