import { expect } from 'chai';
import gql from 'fake-tag';

import { TransactionKind } from '../../../../../server/constants/transaction-kind';
import {
  fakeCollective,
  fakeOrder,
  fakeTransaction,
  fakeUser,
  fakeUserToken,
} from '../../../../test-helpers/fake-data';
import { graphqlQueryV2, oAuthGraphqlQueryV2, resetTestDB } from '../../../../utils';

const transactionQuery = gql`
  query Transaction($transactionId: String!) {
    transaction(transaction: { id: $transactionId }) {
      id
      permissions {
        canDownloadInvoice
      }
      order {
        tax {
          idNumber
        }
      }
    }
  }
`;

describe('TransactionQuery', () => {
  before(resetTestDB);

  it('rejects OAuth token with email scope only', async () => {
    const contributor = await fakeUser();
    const collective = await fakeCollective();
    const order = await fakeOrder({
      FromCollectiveId: contributor.CollectiveId,
      CollectiveId: collective.id,
      data: {
        tax: {
          id: 'VAT',
          idNumber: 'SECRET-TAX-ID',
          percentage: 20,
        },
      },
    });
    const transaction = await fakeTransaction({
      FromCollectiveId: contributor.CollectiveId,
      CollectiveId: collective.id,
      HostCollectiveId: collective.HostCollectiveId,
      kind: TransactionKind.CONTRIBUTION,
      amount: 1000,
      OrderId: order.id,
    });
    const userToken = await fakeUserToken({ user: contributor, scope: ['email'] });

    const result = await oAuthGraphqlQueryV2(transactionQuery, { transactionId: transaction.uuid }, userToken);

    expect(result.errors).to.exist;
    expect(result.errors[0].message).to.equal('The User Token is not allowed for operations in scope "transactions".');
  });

  it('allows session auth for contributors', async () => {
    const contributor = await fakeUser();
    const collective = await fakeCollective();
    const order = await fakeOrder({
      FromCollectiveId: contributor.CollectiveId,
      CollectiveId: collective.id,
      data: {
        tax: {
          id: 'VAT',
          idNumber: 'SECRET-TAX-ID',
          percentage: 20,
        },
      },
    });
    const transaction = await fakeTransaction({
      FromCollectiveId: contributor.CollectiveId,
      CollectiveId: collective.id,
      HostCollectiveId: collective.HostCollectiveId,
      kind: TransactionKind.CONTRIBUTION,
      amount: 1000,
      OrderId: order.id,
    });

    const result = await graphqlQueryV2(transactionQuery, { transactionId: transaction.uuid }, contributor);

    result.errors && console.error(result.errors);
    expect(result.errors).to.not.exist;
    expect(result.data.transaction.permissions.canDownloadInvoice).to.be.true;
    expect(result.data.transaction.order.tax.idNumber).to.equal('SECRET-TAX-ID');
  });
});
