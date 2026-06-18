import roles from '../../../../server/constants/roles';
import models from '../../../../server/models';
import { fakeActiveHost } from '../../../test-helpers/fake-data';
import * as utils from '../../../utils';

let host, admin, collective;

describe('server/graphql/v1/paymentMethods', () => {
  beforeEach(async () => {
    await utils.resetTestDB();
  });

  beforeEach(async () => {
    admin = await models.User.createUserWithCollective({
      name: 'Host Admin',
      email: 'admin@email.com',
    });
  });

  beforeEach(async () => {
    host = await fakeActiveHost({
      admin,
      name: 'open source collective',
      type: 'ORGANIZATION',
      currency: 'USD',
    });

    await host.activateMoneyManagement({ remoteUser: admin });
  });

  beforeEach(() =>
    models.ConnectedAccount.create({
      CollectiveId: host.id,
      service: 'stripe',
      username: 'stripeAccount',
    }),
  );

  beforeEach(async () => {
    collective = await models.Collective.create({
      name: 'tipbox',
      type: 'COLLECTIVE',
      isActive: true,
      approvedAt: new Date(),
      currency: 'EUR',
      hostFeePercent: 5,
      HostCollectiveId: host.id,
    });
  });

  beforeEach(() =>
    models.Member.create({
      CollectiveId: collective.id,
      MemberCollectiveId: host.id,
      role: roles.HOST,
      CreatedByUserId: admin.id,
    }),
  );

  beforeEach(() => collective.addUserWithRole(admin, roles.ADMIN));

  describe('oauth flow', () => {
    // not implemented
  });
});
