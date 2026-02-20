import { expect } from 'chai';
import gqlV1 from 'fake-tag';

import roles from '../../../../server/constants/roles';
import models from '../../../../server/models';
import { fakeActiveHost, fakeOrganization, fakeTransaction } from '../../../test-helpers/fake-data';
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

    await host.activateMoneyManagement(admin);
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

  describe('add funds', () => {
    let hostPaymentMethod;

    beforeEach(async () => {
      hostPaymentMethod = await models.PaymentMethod.findOne({
        where: {
          service: 'opencollective',
          CollectiveId: host.id,
          type: 'host',
        },
      });
    });

    it('gets the list of fromCollectives for the opencollective payment method of the host', async () => {
      // We add funds to the tipbox collective on behalf of Google and Facebook
      const facebook = await fakeOrganization({ name: 'Facebook', currency: 'USD' });
      const google = await fakeOrganization({ name: 'Google', currency: 'USD' });
      const createAddedFunds = org => {
        return fakeTransaction(
          {
            type: 'CREDIT',
            kind: 'ADDED_FUNDS',
            FromCollectiveId: org.id,
            CollectiveId: collective.id,
            PaymentMethodId: hostPaymentMethod.id,
          },
          { createDoubleEntry: true },
        );
      };

      await createAddedFunds(facebook);
      await createAddedFunds(google);

      // We fetch all the fromCollectives using the host paymentMethod
      const paymentMethodQuery = gqlV1 /* GraphQL */ `
        query PaymentMethod($id: Int!) {
          PaymentMethod(id: $id) {
            id
            service
            type
            fromCollectives {
              total
              collectives {
                id
                name
              }
            }
          }
        }
      `;
      const result = await utils.graphqlQuery(paymentMethodQuery, { id: hostPaymentMethod.id }, admin);
      result.errors && console.error(result.errors[0]);
      const { total, collectives } = result.data.PaymentMethod.fromCollectives;
      expect(total).to.equal(2);
      const names = collectives.map(c => c.name).sort();
      expect(names[0]).to.equal('Facebook');
      expect(names[1]).to.equal('Google');
    });
  });
});
