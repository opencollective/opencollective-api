import { expect } from 'chai';

import { backfillConnectedAccountHashes } from '../../../scripts/wise/backfill-connected-account-hashes';
import models from '../../../server/models';
import { hashObject } from '../../../server/paymentProviders/utils';
import { fakeCollective, fakeConnectedAccount } from '../../test-helpers/fake-data';
import { resetTestDB } from '../../utils';

describe('scripts/wise/backfill-connected-account-hashes', () => {
  beforeEach(resetTestDB);

  const createTransferwiseAccount = async (data: Record<string, unknown>, hash = 'legacy') => {
    const collective = await fakeCollective();
    return fakeConnectedAccount({
      CollectiveId: collective.id,
      service: 'transferwise',
      token: 'token',
      data,
      hash,
    });
  };

  it('upgrades the hash and casts data.id to a string for fully populated safe rows', async () => {
    const account = await createTransferwiseAccount(
      { id: 220192, type: 'BUSINESS', personalProfile: { id: 217896, type: 'PERSONAL', userId: 217896 } },
      hashObject({ profileId: 220192, service: 'transferwise', userId: 217896 }),
    );

    const summary = await backfillConnectedAccountHashes({ isDryRun: false });

    expect(summary.migrated).to.equal(1);
    await account.reload();
    expect(account.hash).to.equal(hashObject({ profileId: '220192', service: 'transferwise', userId: '217896' }));
    expect(account.data.id).to.equal('220192');
    expect(typeof account.data.id).to.equal('string');
  });

  it('uses settings.userId when data.personalProfile is absent', async () => {
    const account = await createTransferwiseAccount({ id: 330033, type: 'BUSINESS' });
    await account.update({ settings: { isOwner: true, userId: 330033 } });

    const summary = await backfillConnectedAccountHashes({ isDryRun: false });

    expect(summary.migrated).to.equal(1);
    await account.reload();
    expect(account.hash).to.equal(hashObject({ profileId: '330033', service: 'transferwise', userId: '330033' }));
    expect(account.data.id).to.equal('330033');
  });

  it('skips rows missing the personal userId (not migratable from stored data)', async () => {
    const account = await createTransferwiseAccount({ id: 440044, type: 'BUSINESS' }, 'untouched');

    const summary = await backfillConnectedAccountHashes({ isDryRun: false });

    expect(summary.migrated).to.equal(0);
    expect(summary.skippedMissingUserId).to.equal(1);
    await account.reload();
    expect(account.hash).to.equal('untouched');
    expect(account.data.id).to.equal(440044);
  });

  it('skips rows whose ids are not safe integers', async () => {
    const account = await createTransferwiseAccount(
      {
        id: 9007199254740992,
        type: 'BUSINESS',
        personalProfile: { id: 217896, type: 'PERSONAL', userId: 217896 },
      },
      'untouched',
    );

    const summary = await backfillConnectedAccountHashes({ isDryRun: false });

    expect(summary.migrated).to.equal(0);
    expect(summary.skippedUnsafe).to.equal(1);
    await account.reload();
    expect(account.hash).to.equal('untouched');
    expect(account.data.id).to.equal(9007199254740992);
  });

  it('ignores accounts without a data.id (mirror/empty rows)', async () => {
    const account = await createTransferwiseAccount({ type: 'BUSINESS' }, 'untouched');

    const summary = await backfillConnectedAccountHashes({ isDryRun: false });

    expect(summary.migrated).to.equal(0);
    expect(summary.skippedMissingId).to.equal(1);
    await account.reload();
    expect(account.hash).to.equal('untouched');
  });

  it('ignores non-transferwise and soft-deleted accounts', async () => {
    const collective = await fakeCollective();
    await fakeConnectedAccount({ CollectiveId: collective.id, service: 'stripe', data: { id: 1 } });
    const deleted = await createTransferwiseAccount({
      id: 550055,
      type: 'BUSINESS',
      personalProfile: { userId: 550055 },
    });
    await deleted.destroy();

    const summary = await backfillConnectedAccountHashes({ isDryRun: false });

    expect(summary.migrated).to.equal(0);
    await deleted.reload({ paranoid: false });
    expect(deleted.data.id).to.equal(550055);
  });

  it('does not write anything in dry-run mode but reports what would change', async () => {
    const account = await createTransferwiseAccount(
      { id: 660066, type: 'BUSINESS', personalProfile: { userId: 660066 } },
      'untouched',
    );

    const summary = await backfillConnectedAccountHashes({ isDryRun: true });

    expect(summary.migrated).to.equal(1);
    expect(summary.isDryRun).to.equal(true);
    await account.reload();
    expect(account.hash).to.equal('untouched');
    expect(account.data.id).to.equal(660066);
  });

  it('is idempotent: a second run migrates nothing', async () => {
    await createTransferwiseAccount(
      { id: 770077, type: 'BUSINESS', personalProfile: { userId: 770077 } },
      hashObject({ profileId: 770077, service: 'transferwise', userId: 770077 }),
    );

    const first = await backfillConnectedAccountHashes({ isDryRun: false });
    const second = await backfillConnectedAccountHashes({ isDryRun: false });

    expect(first.migrated).to.equal(1);
    expect(second.migrated).to.equal(0);
    const remaining = await models.ConnectedAccount.findAll({
      where: { service: 'transferwise' },
    });
    expect(remaining[0].hash).to.equal(hashObject({ profileId: '770077', service: 'transferwise', userId: '770077' }));
    expect(remaining[0].data.id).to.equal('770077');
  });
});
