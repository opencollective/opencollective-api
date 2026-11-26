import { expect } from 'chai';
import { createSandbox } from 'sinon';

import { regenerateConnectedAccounts } from '../../../scripts/wise/regenerate-connected-accounts';
import * as transferwiseLib from '../../../server/lib/transferwise';
import models from '../../../server/models';
import { hashObject } from '../../../server/paymentProviders/utils';
import { fakeCollective, fakeConnectedAccount } from '../../test-helpers/fake-data';
import { resetTestDB } from '../../utils';

describe('scripts/wise/regenerate-connected-accounts', () => {
  const sandbox = createSandbox();

  // `userId` is the Wise personal profile owner id, shared with the business profile.
  const personalProfile = { id: 217896, type: 'PERSONAL', userId: 9999 };
  const businessProfile = { id: 220192, type: 'BUSINESS', companyRole: 'OWNER', userId: 9999 };

  beforeEach(resetTestDB);
  afterEach(() => sandbox.restore());

  const createTransferwiseAccount = async (data: Record<string, unknown>, overrides: Record<string, unknown> = {}) => {
    const collective = await fakeCollective();
    return fakeConnectedAccount({
      CollectiveId: collective.id,
      service: 'transferwise',
      token: 'token',
      data,
      ...overrides,
    });
  };

  it('repopulates the missing personalProfile and regenerates data/settings/hash', async () => {
    sandbox.stub(transferwiseLib, 'getProfiles').resolves([personalProfile, businessProfile] as any);
    const account = await createTransferwiseAccount({ id: 220192, type: 'BUSINESS' });

    const summary = await regenerateConnectedAccounts({ isDryRun: false });

    expect(summary.regenerated).to.equal(1);
    expect(summary.failed).to.equal(0);
    await account.reload();
    expect(account.data.personalProfile).to.deep.equal(personalProfile);
    expect(account.data.id).to.equal(businessProfile.id);
    expect(account.settings.userId).to.equal(personalProfile.userId);
    expect(account.settings.isOwner).to.equal(true);
    expect(account.hash).to.equal(
      hashObject({ profileId: businessProfile.id, service: 'transferwise', userId: personalProfile.userId }),
    );
  });

  it('ignores mirrored connected accounts', async () => {
    const getProfilesStub = sandbox.stub(transferwiseLib, 'getProfiles').rejects(new Error('should not be called'));
    await createTransferwiseAccount({ id: 220192, type: 'BUSINESS' }, { token: null, settings: { isMirror: true } });
    await createTransferwiseAccount(
      { id: 220193, type: 'BUSINESS', MirrorConnectedAccountId: 1 },
      { token: null, settings: {} },
    );

    const summary = await regenerateConnectedAccounts({ isDryRun: false });

    expect(summary.skippedMirror).to.equal(2);
    expect(summary.regenerated).to.equal(0);
    expect(getProfilesStub.called).to.be.false;
  });

  it('fails when there is no PERSONAL profile and does not write anything', async () => {
    sandbox.stub(transferwiseLib, 'getProfiles').resolves([businessProfile] as any);
    const account = await createTransferwiseAccount({ id: 220192, type: 'BUSINESS' }, { hash: 'untouched' });

    const summary = await regenerateConnectedAccounts({ isDryRun: false });

    expect(summary.regenerated).to.equal(0);
    expect(summary.failed).to.equal(1);
    expect(summary.errors[0].connectedAccountId).to.equal(account.id);
    expect(summary.errors[0].message).to.match(/exactly one PERSONAL/);
    await account.reload();
    expect(account.hash).to.equal('untouched');
    expect(account.data.personalProfile).to.equal(undefined);
  });

  it('fails when there is more than one PERSONAL profile', async () => {
    sandbox
      .stub(transferwiseLib, 'getProfiles')
      .resolves([personalProfile, { ...personalProfile, id: 217897 }, businessProfile] as any);
    const account = await createTransferwiseAccount({ id: 220192, type: 'BUSINESS' }, { hash: 'untouched' });

    const summary = await regenerateConnectedAccounts({ isDryRun: false });

    expect(summary.failed).to.equal(1);
    expect(summary.errors[0].message).to.match(/exactly one PERSONAL/);
    await account.reload();
    expect(account.hash).to.equal('untouched');
  });

  it('skips accounts that already have a personalProfile unless --all is used', async () => {
    const getProfilesStub = sandbox
      .stub(transferwiseLib, 'getProfiles')
      .resolves([personalProfile, businessProfile] as any);
    const account = await createTransferwiseAccount({
      id: 220192,
      type: 'BUSINESS',
      personalProfile: { id: 217896, type: 'PERSONAL', userId: 1234 },
    });

    const skipped = await regenerateConnectedAccounts({ isDryRun: false });
    expect(skipped.skippedAlreadyPopulated).to.equal(1);
    expect(skipped.regenerated).to.equal(0);
    expect(getProfilesStub.called).to.be.false;

    const forced = await regenerateConnectedAccounts({ isDryRun: false, all: true });
    expect(forced.regenerated).to.equal(1);
    await account.reload();
    expect(account.data.personalProfile.userId).to.equal(personalProfile.userId);
    expect(account.settings.userId).to.equal(personalProfile.userId);
  });

  it('does not write anything in dry-run mode but reports what would change', async () => {
    sandbox.stub(transferwiseLib, 'getProfiles').resolves([personalProfile, businessProfile] as any);
    const account = await createTransferwiseAccount({ id: 220192, type: 'BUSINESS' }, { hash: 'untouched' });

    const summary = await regenerateConnectedAccounts({ isDryRun: true });

    expect(summary.regenerated).to.equal(1);
    expect(summary.isDryRun).to.equal(true);
    await account.reload();
    expect(account.hash).to.equal('untouched');
    expect(account.data.personalProfile).to.equal(undefined);
  });

  it('skips non-mirrored accounts without credentials', async () => {
    const getProfilesStub = sandbox.stub(transferwiseLib, 'getProfiles').rejects(new Error('should not be called'));
    await createTransferwiseAccount(
      { id: 220192, type: 'BUSINESS' },
      { token: null, refreshToken: null, settings: {} },
    );

    const summary = await regenerateConnectedAccounts({ isDryRun: false });

    expect(summary.skippedWithoutToken).to.equal(1);
    expect(getProfilesStub.called).to.be.false;
  });

  it('ignores non-transferwise and soft-deleted accounts', async () => {
    sandbox.stub(transferwiseLib, 'getProfiles').resolves([personalProfile, businessProfile] as any);
    const collective = await fakeCollective();
    await fakeConnectedAccount({ CollectiveId: collective.id, service: 'stripe', data: { id: 1 } });
    const deleted = await createTransferwiseAccount({ id: 220192, type: 'BUSINESS' });
    await deleted.destroy();

    const summary = await regenerateConnectedAccounts({ isDryRun: false });

    expect(summary.scanned).to.equal(0);
    expect(summary.regenerated).to.equal(0);
    expect(await models.ConnectedAccount.count({ where: { service: 'transferwise' }, paranoid: false })).to.equal(1);
  });
});
