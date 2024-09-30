import { expect } from 'chai';
import { times } from 'lodash';

import PlatformConstants from '../../../server/constants/platform';
import { TransactionKind } from '../../../server/constants/transaction-kind';
import models, { Op } from '../../../server/models';
import TransactionSettlement, { TransactionSettlementStatus } from '../../../server/models/TransactionSettlement';
import {
  fakeCollective,
  fakeExpense,
  fakeHost,
  fakeOrganization,
  fakeTransaction,
  fakeUser,
  fakeUUID,
} from '../../test-helpers/fake-data';
import * as utils from '../../utils';

// ---- Helpers ----

const fakeContribution = (fromCollective, collective, transactionGroup) => {
  return fakeTransaction(
    {
      TransactionGroup: fakeUUID(transactionGroup),
      kind: TransactionKind.CONTRIBUTION,
      CollectiveId: collective.id,
      HostCollectiveId: collective.HostCollectiveId,
      FromCollectiveId: fromCollective.id,
      amount: 1000,
      type: 'CREDIT',
      description: 'A simple contribution **without** platform tip',
    },
    {
      createDoubleEntry: true,
    },
  );
};

// Insert contributions **with platform tips**, using the new format described in https://github.com/opencollective/opencollective/issues/4124.
// As writing this, the rest of the code is not yet using this new format.
const fakeContributionWithPlatformTipNewFormat = async (fromCollective, collective, transactionGroup) => {
  // Base transaction
  const transaction = await fakeTransaction(
    {
      TransactionGroup: fakeUUID(transactionGroup),
      kind: TransactionKind.CONTRIBUTION,
      FromCollectiveId: fromCollective.id,
      CollectiveId: collective.id,
      HostCollectiveId: collective.isHostAccount ? collective.id : collective.HostCollectiveId,
      amount: 1000,
      description: 'A contribution **with** platform tip',
    },
    {
      createDoubleEntry: true,
    },
  );

  // DEBIT Tip transaction (contributor -> OC)
  await fakeTransaction({
    TransactionGroup: transaction.TransactionGroup,
    kind: TransactionKind.PLATFORM_TIP,
    type: 'DEBIT',
    amount: -200,
    CollectiveId: transaction.FromCollectiveId,
    FromCollectiveId: PlatformConstants.PlatformCollectiveId,
    HostCollectiveId: null,
    description: 'Tip transaction from the contributor to Open Collective',
  });

  // CREDIT Tip transaction (contributor -> OC)
  await fakeTransaction({
    TransactionGroup: transaction.TransactionGroup,
    kind: TransactionKind.PLATFORM_TIP,
    type: 'CREDIT',
    amount: 200,
    FromCollectiveId: transaction.FromCollectiveId,
    CollectiveId: PlatformConstants.PlatformCollectiveId,
    HostCollectiveId: PlatformConstants.PlatformCollectiveId,
    description: 'Tip transaction from the contributor to Open Collective',
  });

  // [Debt] DEBIT Tip debt transaction (host -> OC)
  await fakeTransaction({
    kind: TransactionKind.PLATFORM_TIP_DEBT,
    TransactionGroup: transaction.TransactionGroup,
    type: 'DEBIT',
    amount: -200,
    FromCollectiveId: transaction.HostCollectiveId,
    CollectiveId: PlatformConstants.PlatformCollectiveId,
    HostCollectiveId: transaction.HostCollectiveId,
    isDebt: true,
    description: 'Tip transaction from the HOST to Open Collective',
  });

  // [Debt] CREDIT Tip debt transaction (host -> OC)
  const tipDebtCreditTransaction = await fakeTransaction({
    kind: TransactionKind.PLATFORM_TIP_DEBT,
    type: 'CREDIT',
    TransactionGroup: transaction.TransactionGroup,
    amount: 200,
    FromCollectiveId: PlatformConstants.PlatformCollectiveId,
    CollectiveId: transaction.HostCollectiveId,
    HostCollectiveId: PlatformConstants.PlatformCollectiveId,
    isDebt: true,
    description: 'Tip transaction from the HOST to Open Collective',
  });

  // [Debt] Transaction Settlement
  await models.TransactionSettlement.createForTransaction(tipDebtCreditTransaction);
};

const SNAPSHOT_COLUMNS = [
  'TransactionGroup',
  'type',
  'kind',
  'amount',
  'CollectiveId',
  'FromCollectiveId',
  'HostCollectiveId',
  'isDebt',
  'isRefund',
  'settlementStatus',
  'description',
];

// ---- Test ----

describe('server/models/TransactionSettlement', () => {
  let host, collective;

  before(async () => {
    await utils.resetTestDB();

    await fakeOrganization({ id: PlatformConstants.PlatformCollectiveId, name: 'Open Collective' });
    host = await fakeHost({ name: 'Open Source' });
    collective = await fakeCollective({ HostCollectiveId: host.id, name: 'ESLint' });

    // Insert unrelated transactions (to make sure they won't appear in the results)
    await Promise.all(
      times(5, () =>
        fakeTransaction({ description: 'Random contribution to another collective' }, { createDoubleEntry: true }),
      ),
    );

    // Insert contributions to host and hosted collectives
    const fromUser = await fakeUser(undefined, { name: 'Benjamin' });
    await fakeContribution(fromUser.collective, host, '00000001');
    await fakeContribution(fromUser.collective, collective, '00000002');

    // Insert contributions with platform tips to host and hosted collectives
    await fakeContributionWithPlatformTipNewFormat(fromUser.collective, host, '00000003');
    await fakeContributionWithPlatformTipNewFormat(fromUser.collective, collective, '00000004');
  });

  it('0. Properly initializes test data', async () => {
    // Snapshot initial state for simpler reviews & debug. Ignore unrelated transactions
    const watchedCollectiveIds = [collective.id, host.id, PlatformConstants.PlatformCollectiveId];
    const transactions = await models.Transaction.findAll({
      include: [{ association: 'host' }, { association: 'collective' }, { association: 'fromCollective' }],
      order: [['id', 'ASC']],
      where: {
        [Op.or]: [
          { CollectiveId: watchedCollectiveIds },
          { FromCollectiveId: watchedCollectiveIds },
          { HostCollectiveId: watchedCollectiveIds },
        ],
      },
    });

    await TransactionSettlement.attachStatusesToTransactions(transactions);
    utils.snapshotTransactions(transactions, { columns: SNAPSHOT_COLUMNS });
  });

  it('1. getHostDebts returns all debts for host', async () => {
    const debts = await TransactionSettlement.getHostDebts(host.id);
    await utils.preloadAssociationsForTransactions(debts, SNAPSHOT_COLUMNS);
    utils.snapshotTransactions(debts, { columns: SNAPSHOT_COLUMNS, loadAssociations: true });
  });

  it('2. updateTransactionsSettlementStatus updates statuses selectively', async () => {
    const debts = await TransactionSettlement.getHostDebts(host.id);
    const debtToUpdate = debts[0]; // Only settle the first debt
    const newStatus = TransactionSettlementStatus.SETTLED;
    const settlementExpense = await fakeExpense();
    await TransactionSettlement.updateTransactionsSettlementStatus([debtToUpdate], newStatus, settlementExpense.id);

    const updatedDebts = await TransactionSettlement.getHostDebts(host.id);
    await utils.preloadAssociationsForTransactions(updatedDebts, SNAPSHOT_COLUMNS);
    utils.snapshotTransactions(updatedDebts, { columns: SNAPSHOT_COLUMNS, loadAssociations: true });
  });

  it('3. getHostDebts can then filter by settlement status', async () => {
    const debts = await TransactionSettlement.getHostDebts(host.id, TransactionSettlementStatus.OWED);
    await utils.preloadAssociationsForTransactions(debts, SNAPSHOT_COLUMNS);
    utils.snapshotTransactions(debts, { columns: SNAPSHOT_COLUMNS, loadAssociations: true });
  });

  it('4. getAccountsWithOwedSettlements returns all accounts with OWED debts', async () => {
    const collectives = await TransactionSettlement.getAccountsWithOwedSettlements();
    expect(collectives.length).to.eq(1);
    expect(collectives[0].id).to.eq(host.id);
  });
});
