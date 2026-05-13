import { expect } from 'chai';

import { checkHostedAccountsPrivateUnderPrivateHost } from '../../../../checks/model/hosted-collectives';
import models from '../../../../server/models';
import { fakeActiveHost, fakeCollective, fakePrivateHost } from '../../../test-helpers/fake-data';
import { resetTestDB } from '../../../utils';

describe('checks/model/hosted-collectives: checkHostedAccountsPrivateUnderPrivateHost', () => {
  beforeEach(async () => {
    await resetTestDB();
  });

  it('does not throw when hosted accounts under a private host have isPrivate true', async () => {
    const privateHost = await fakePrivateHost();
    await fakeCollective({
      HostCollectiveId: privateHost.id,
      isPrivate: true,
      approvedAt: new Date(),
    });

    await expect(checkHostedAccountsPrivateUnderPrivateHost({ fix: false })).to.be.fulfilled;
  });

  it('does not flag collectives hosted by a non-private fiscal host', async () => {
    const host = await fakeActiveHost();
    const collective = await fakeCollective({ HostCollectiveId: host.id, approvedAt: new Date() });
    await models.Collective.update({ isPrivate: false }, { where: { id: collective.id }, hooks: false });

    await expect(checkHostedAccountsPrivateUnderPrivateHost({ fix: false })).to.be.fulfilled;
  });

  it('throws when a hosted collective has isPrivate=false under a private fiscal host', async () => {
    const privateHost = await fakePrivateHost();
    const collective = await fakeCollective({
      HostCollectiveId: privateHost.id,
      isPrivate: true,
      approvedAt: new Date(),
    });
    await models.Collective.update({ isPrivate: false }, { where: { id: collective.id }, hooks: false });

    await expect(checkHostedAccountsPrivateUnderPrivateHost({ fix: false })).to.be.rejectedWith(
      /Collectives hosted by a private fiscal host without isPrivate=true/,
    );
  });

  it('sets isPrivate=true for inconsistent rows when fix is enabled', async () => {
    const privateHost = await fakePrivateHost();
    const collective = await fakeCollective({
      HostCollectiveId: privateHost.id,
      isPrivate: true,
      approvedAt: new Date(),
    });
    await models.Collective.update({ isPrivate: false }, { where: { id: collective.id }, hooks: false });

    await checkHostedAccountsPrivateUnderPrivateHost({ fix: true });

    await collective.reload();
    expect(collective.isPrivate).to.be.true;

    await expect(checkHostedAccountsPrivateUnderPrivateHost({ fix: false })).to.be.fulfilled;
  });
});
