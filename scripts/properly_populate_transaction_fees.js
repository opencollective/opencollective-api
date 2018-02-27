import { ArgumentParser } from 'argparse';
import models, { sequelize } from '../server/models';

class Migration {
  constructor(options) {
    this.options = options;
    this.offset = 0;
    this.migrated = 0;
  }

  /** Retrieve the total number of valid transactions */
  countValidTransactions = async () => {
    return models.Transaction.count({ where: { deletedAt: null } });
  }

  /** Retrieve a batch of valid transactions */
  retrieveValidTransactions = async () => {
    const transactions = await models.Transaction.findAll({
      where: { deletedAt: null },
      order: ['TransactionGroup'],
      limit: this.options.batchSize,
      offset: this.offset
    });
    this.offset += transactions.length;
    return transactions;
  }

  /** Verify values of fees in a transaction */
  verifyFees = (tr) => {
    return tr.amountInHostCurrency +
      tr.hostFeeInHostCurrency +
      tr.platformFeeInHostCurrency +
      tr.paymentProcessorFeeInHostCurrency === (tr.netAmountInCollectiveCurrency * tr.hostCurrencyFxRate);
  }

  /** Convert `value` to negative if it's possitive */
  toNegative = (value) => {
    return value > 0 ? -value : value;
  }

  /** Rewrite the values of the fees */
  rewriteFees = (credit, debit) => {
    credit.hostFeeInHostCurrency = debit.hostFeeInHostCurrency = this.toNegative(credit.hostFeeInHostCurrency);
    credit.platformFeeInHostCurrency = debit.platformFeeInHostCurrency = this.toNegative(credit.platformFeeInHostCurrency);
    credit.paymentProcessorFeeInHostCurrency = debit.paymentProcessorFeeInHostCurrency = this.toNegative(credit.paymentProcessorFeeInHostCurrency);
  }

  /** Migrate one pair of transactions */
  migrate = async (tr1, tr2) => {
    console.log(tr1.TransactionGroup);
    console.log(tr2.TransactionGroup);
    if (tr1.TransactionGroup !== tr2.TransactionGroup) {
      throw new Error('Wrong transaction pair detected');
    }
    const credit = tr1.type === 'CREDIT' ? tr1 : tr2;
    const debit =  tr1.type === 'DEBIT' ? tr1 : tr2;
    if (tr1.ExpenseId !== null && tr1.ExpenseId === tr2.ExpenseId) {
      console.log('  Expense.:', this.verifyFees(tr1), this.verifyFees(tr2));
    } else if (tr1.OrderId !== null && tr1.OrderId === tr2.OrderId) {
      console.log('  Order...:', this.verifyFees(tr1), this.verifyFees(tr2));
      this.rewriteFees(credit, debit);
      if (!this.verifyFees(credit)) {
        console.log(`    Transaction CREDIT ${credit.TransactionGroup} doesn't add up`);
      }
      if (!this.verifyFees(debit)) {
        console.log(`    Transaction DEBIT ${credit.TransactionGroup} doesn't add up`);
      }

      // if (!credit.hostFeeInHostCurrency)
      //   console.log('    * WARNING: C:hostFee.....: ', credit.hostFeeInHostCurrency);
      // if (!credit.platformFeeInHostCurrency)
      //   console.log('    * WARNING: C:platformFee.: ', credit.platformFeeInHostCurrency);
      // if (!credit.paymentProcessorFeeInHostCurrency)
      //   console.log('    * WARNING: C:ppFee.......: ', credit.paymentProcessorFeeInHostCurrency);
    } else {
      console.log('  WAT.....:', this.verifyFees(tr1), this.verifyFees(tr2));
    }

    console.log('    * C:amount......: ', credit.amountInHostCurrency);
    console.log('    * C:netAmount...: ', credit.netAmountInCollectiveCurrency);
    console.log('    * C:hostFee.....: ', credit.hostFeeInHostCurrency);
    console.log('    * C:platformFee.: ', credit.platformFeeInHostCurrency);
    console.log('    * C:ppFee.......: ', credit.paymentProcessorFeeInHostCurrency);

    console.log('    * D:amount......: ', debit.amountInHostCurrency);
    console.log('    * D:netAmount...: ', debit.netAmountInCollectiveCurrency);
    console.log('    * D:hostFee.....: ', debit.hostFeeInHostCurrency);
    console.log('    * D:platformFee.: ', debit.platformFeeInHostCurrency);
    console.log('    * D:ppFee.......: ', debit.paymentProcessorFeeInHostCurrency);
  }

  /** Run the whole migration */
  run = async () => {
    const count = this.options.limit || await this.countValidTransactions();
    while (this.offset < count) {
      /* Transactions are sorted by their TransactionGroup, which
       * means that the first transaction is followed by its negative
       * transaction, the third transaction is followed by its pair
       * and so forth. */
      const transactions = await this.retrieveValidTransactions();
      for (let i = 0; i < transactions.length; i += 2) {
        /* Sanity check */
        if (transactions[i].TransactionGroup !== transactions[i + 1].TransactionGroup) {
          throw new Error(`Cannot find pair for the transaction id ${transactions[i].id}`);
        }
        /* Migrate the pair that we just found */
        this.migrate(transactions[i], transactions[i + 1]);
      }
    }
  }
}

/* -- Utilities & Script Entry Point -- */

/** Return the options passed by the user to run the script */
function parseCommandLineArguments() {
  const parser = new ArgumentParser({
    addHelp: true,
    description: 'Charge due subscriptions'
  });
  parser.addArgument(['-v', '--verbose'], {
    help: 'Verbose output',
    defaultValue: false,
    action: 'storeConst',
    constant: true
  });
  parser.addArgument(['--notdryrun'], {
    help: "Pass this flag when you're ready to run the script for real",
    defaultValue: false,
    action: 'storeConst',
    constant: true
  });
  parser.addArgument(['-l', '--limit'], {
    help: 'total subscriptions to process'
  });
  parser.addArgument(['-b', '--batch-size'], {
    help: 'batch size to fetch at a time',
    defaultValue: 10
  });
  const args = parser.parseArgs();
  return {
    dryRun: !args.notdryrun,
    verbose: args.verbose,
    limit: args.limit,
    batchSize: args.batch_size || 100
  };
}

/** Print `message` to console if `options.verbose` is true */
function vprint(options, message) {
  if (options.verbose) {
    console.log(message);
  }
}

/** Kick off the script with all the user selected options */
async function entryPoint(options) {
  vprint(options, 'Starting to migrate fees');
  try {
    await (new Migration(options)).run();
  } finally {
    await sequelize.close();
  }
  vprint(options, 'Finished migrating fees');
}

/* Entry point */
entryPoint(parseCommandLineArguments());
