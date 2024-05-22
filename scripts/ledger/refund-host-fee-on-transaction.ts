import '../../server/env';

import { Command } from 'commander';
import { v4 as uuid } from 'uuid';

import { refundHostFee } from '../../server/lib/payments';
import models from '../../server/models';

const DRY_RUN = process.env.DRY_RUN !== 'false';

if (DRY_RUN) {
  console.log('DRY RUN: No changes will be made');
}

const program = new Command()
  .description('Helper to refund host fees on a given transaction')
  .arguments('TransactionGroup UserCollectiveSlug')
  .parse();

const main = async () => {
  const transactionGroup = program.args[0];
  const userCollectiveSlug = program.args[1];
  const user = await models.User.findOne({
    include: [
      {
        association: 'collective',
        attributes: [],
        where: { slug: userCollectiveSlug },
        required: true,
      },
    ],
  });

  if (!user) {
    throw new Error(`User ${userCollectiveSlug} not found`);
  }

  // Any kind would do the job since refund is then calling `transaction.getHostFeeTransaction()` but
  // we want to stay as close as possible to the original flow
  const transaction = await models.Transaction.findOne({
    where: { TransactionGroup: transactionGroup, type: 'CREDIT', kind: ['CONTRIBUTION', 'ADDED_FUNDS'] },
  });

  if (!transaction) {
    throw new Error(`Transaction ${transactionGroup} not found`);
  }

  console.log(
    `Refunding host fee for transaction ${transactionGroup} (${transaction.description}) on behalf of ${userCollectiveSlug}`,
  );
  if (!DRY_RUN) {
    await refundHostFee(transaction, user, 0, uuid());
  }
};

// Only run script if called directly (to allow unit tests)
if (!module.parent) {
  main()
    .then(() => process.exit(0))
    .catch(e => {
      console.error(e);
      process.exit(1);
    });
}
