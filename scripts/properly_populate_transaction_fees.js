import { ArgumentParser } from 'argparse';
import models, { sequelize } from '../server/models';

class Migration {
  constructor(options) {
    this.options = options;
    this.offset = 0;
    this.migrated = 0;

    this.countValidTransactions = this.countValidTransactions.bind(this);
    this.retrieveValidTransactions = this.retrieveValidTransactions.bind(this);
    this.migrate = this.migrate.bind(this);
    this.run = this.run.bind(this);
  }
  /** Retrieve the total number of valid transactions */
  async countValidTransactions() {
    return models.Transaction.count({ where: { deletedAt: null } });
  }
  /** Retrieve a batch of valid transactions */
  async retrieveValidTransactions() {
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
  verifyFees(tr) {
    return tr.amountInHostCurrency +
      tr.hostFeeInHostCurrency +
      tr.platformFeeInHostCurrency +
      tr.paymentProcessorFeeInHostCurrency === (tr.netAmountInCollectiveCurrency * tr.hostCurrencyFxRate);
  }
  /** Migrate one pair of transactions */
  async migrate(tr1, tr2) {
    // if (tr1.type === 'CREDIT') {}
    console.log(tr1.TransactionGroup);
    console.log(this.verifyFees(tr1));
    console.log(this.verifyFees(tr2));
  }
  /** Run the whole migration */
  async run() {
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
