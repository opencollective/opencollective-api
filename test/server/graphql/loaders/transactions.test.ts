import { expect } from 'chai';
import gql from 'fake-tag';

import { TransactionKind } from '../../../../server/constants/transaction-kind';
import { generateHostFeeAmountForTransactionLoader } from '../../../../server/graphql/loaders/transactions';
import models from '../../../../server/models';
import { fakeActiveHost, fakeCollective, fakeOrganization, fakeUser } from '../../../test-helpers/fake-data';
import { graphqlQueryV2, resetTestDB } from '../../../utils';

const addFundsMutation = gql`
  mutation AddFunds(
    $fromAccount: AccountReferenceInput!
    $account: AccountReferenceInput!
    $amount: AmountInput!
    $hostFeePercent: Float!
  ) {
    addFunds(
      account: $account
      fromAccount: $fromAccount
      amount: $amount
      description: "Added funds"
      hostFeePercent: $hostFeePercent
    ) {
      publicId
    }
  }
`;

describe('server/graphql/loaders/transactions', () => {
  describe('generateHostFeeAmountForTransactionLoader', () => {
    let hostAdmin, host, collective, otherOrg;

    before(async () => {
      await resetTestDB();
      hostAdmin = await fakeUser();
      host = await fakeActiveHost({ admin: hostAdmin, currency: 'USD', hostFeePercent: 10 });
      collective = await fakeCollective({ HostCollectiveId: host.id, currency: 'USD' });
      otherOrg = await fakeOrganization({ admin: hostAdmin });
    });

    const addFunds = async fromAccount => {
      const result = await graphqlQueryV2(
        addFundsMutation,
        {
          account: { legacyId: collective.id },
          fromAccount: { legacyId: fromAccount.id },
          amount: { valueInCents: 10000, currency: 'USD' },
          hostFeePercent: 10,
        },
        hostAdmin,
      );
      expect(result.errors).to.not.exist;
      const order = await models.Order.findOne({ where: { publicId: result.data.addFunds.publicId } });
      return models.Transaction.findAll({ where: { OrderId: order.id, kind: TransactionKind.ADDED_FUNDS } });
    };

    const loadHostFees = async (transactions: InstanceType<typeof models.Transaction>[]) => {
      const loader = generateHostFeeAmountForTransactionLoader();
      const credit = transactions.find(t => t.type === 'CREDIT');
      const debit = transactions.find(t => t.type === 'DEBIT');
      return { credit: await loader.load(credit), debit: await loader.load(debit) };
    };

    it('returns the host fee on the CREDIT leg only', async () => {
      const hostFees = await loadHostFees(await addFunds(otherOrg));
      expect(hostFees).to.deep.eq({ credit: -1000, debit: 0 });
    });

    it('does not pick up the host fee received by the host when the host is the contributor', async () => {
      const hostFees = await loadHostFees(await addFunds(host));
      expect(hostFees).to.deep.eq({ credit: -1000, debit: 0 });
    });
  });
});
