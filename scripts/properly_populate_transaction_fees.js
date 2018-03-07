/**
 * These are some recommendations for using the script in
 * *development* mode. We currently have ~70000 transactions in our
 * database, running it with a large batch to process all the
 * transactions at once is the fastest way to run it and get the
 * output, however it also exhausts node's memory limits with batches
 * larger than ~50000. Use --max-old-space=8192 to do it all in one
 * batch and iterate faster.
 *
 * For production usage, It might be a good idea to break it down in
 * multiple batches to leave some room for the database to process
 * operations from the web clients. I've been running 7 batches of
 * 10000 and didn't take more than ~20s in my machine (i7~2.2GHz),
 * which is just a little bit slower than running it all in one batch.
 */
import { ArgumentParser } from 'argparse';
import models, { sequelize } from '../server/models';
import * as transactionsLib from '../server/lib/transactions';
import * as paymentsLib from '../server/lib/payments';
import { OC_FEE_PERCENT } from '../server/constants/transactions';

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
      offset: this.offset,
      include: [{ model: models.Collective, as: 'collective' }]
    });
    this.offset += transactions.length;
    return transactions;
  }

  /** Convert `value` to negative if it's possitive */
  toNegative = (value) => value > 0 ? -value : value;

  /** Ensure that `tr` has the `hostCurrencyFxRate` field filled in */
  ensureHostCurrencyFxRate = (tr) => {
    if (tr.amount === tr.amountInHostCurrency && !tr.hostCurrencyFxRate)
      tr.hostCurrencyFxRate = 1;
  }

  /** Return true if the transaction has any host fees */
  hasHostFee = (tr) => tr.hostFeeInHostCurrency
    && parseInt(tr.hostFeeInHostCurrency, 10) !== 0;
  /** Return true if the transaction has any platform fees */
  hasPlatformFee = (tr) => tr.paymentProcessorFeeInHostCurrency
    && parseInt(tr.paymentProcessorFeeInHostCurrency, 10) !== 0;
  /** Return false if there are no fees on a transaction */
  hasFees = (tr) => this.hasHostFee(tr) || this.hasPlatformFee(tr)
    || (tr.platformFeeInHostCurrency && parseInt(tr.platformFeeInHostCurrency, 10) !== 0);

  rewriteFees = (credit, debit) => {
    credit.hostFeeInHostCurrency = debit.hostFeeInHostCurrency =
      this.toNegative(credit.hostFeeInHostCurrency || credit.hostFeeInHostCurrency);
    credit.platformFeeInHostCurrency = debit.platformFeeInHostCurrency =
      this.toNegative(credit.platformFeeInHostCurrency || debit.platformFeeInHostCurrency);
    credit.paymentProcessorFeeInHostCurrency = debit.paymentProcessorFeeInHostCurrency =
      this.toNegative(credit.paymentProcessorFeeInHostCurrency || debit.paymentProcessorFeeInHostCurrency);
  }

  /** Fix rounding errors in fees and rewrite netAmount */
  rewriteFeesAndNetAmount = (credit, debit) => {
    if (!credit.collective || !debit.collective) {
      if (!credit.collective) console.log('credit with no collective!!!!', credit.id);
      if (!debit.collective) console.log('debit with no collective!!!!', credit.id);
      return;
    }

    /* Recalculate Host Fee */
    let hostFeePercent;
    if (this.hasHostFee(credit) || this.hasHostFee(debit)) {
      hostFeePercent = Math.round(-this.toNegative(
        (credit.hostFeePercent || debit.hostFeePercent) * 100 / credit.amountInHostCurrency));
    }
    if (hostFeePercent != 5 && hostFeePercent != 10 && hostFeePercent !== 0)
      console.log('Suspicious hostFee',
                  credit.id,
                  credit.amountInHostCurrency,
                  credit.amountInHostCurrency * hostFeePercent / 100,
                  hostFeePercent);

    /* Recalculate Platform Fee */
    const platformFeePercent = Math.round(-this.toNegative(
      credit.platformFeeInHostCurrency * 100 / credit.amountInHostCurrency));
    if (platformFeePercent != 5 && platformFeePercent !== 0)
      console.log('Suspicious platformFee',
                  credit.id,
                  credit.amountInHostCurrency,
                  credit.amountInHostCurrency * 0.05,
                  platformFeePercent);

    /* This */
    credit.platformFeeInHostCurrency = this.toNegative(
      paymentsLib.calcFee(credit.amountInHostCurrency, OC_FEE_PERCENT));
    debit.platformFeeInHostCurrency = this.toNegative(
      paymentsLib.calcFee(credit.amountInHostCurrency, OC_FEE_PERCENT));

    credit.netAmountInCollectiveCurrency = transactionsLib.netAmount(credit);
    debit.netAmountInCollectiveCurrency = -credit.amountInHostCurrency * credit.hostCurrencyFxRate;
  }

  /** Make sure two transactions are pairs of each other */
  validatePair = (tr1, tr2) => {
    if (tr1.TransactionGroup !== tr2.TransactionGroup) {
      throw new Error('Wrong transaction pair detected');
    }
    if (tr1.ExpenseId !== tr2.ExpenseId) {
      throw new Error('Wrong transaction pair detected: ExpenseId does not match');
    }
    if (tr1.OrderId !== tr2.OrderId) {
      throw new Error('Wrong transaction pair detected: OrderId does not match');
    }
  }

  /** Migrate one pair of transactions */
  migrate = async (tr1, tr2) => {
    console.log(tr1.TransactionGroup);
    console.log(tr2.TransactionGroup);
    this.validatePair(tr1, tr2);

    const credit = tr1.type === 'CREDIT' ? tr1 : tr2;
    const debit =  tr1.type === 'DEBIT' ? tr1 : tr2;

    if (tr1.ExpenseId !== null) {
      // Both CREDIT & DEBIT transactions add up
      if (transactionsLib.verify(credit) && transactionsLib.verify(debit)) {
        console.log('Expense.: true, true');
        return;
      }

      // this.rewriteFees(credit, debit);

      console.log('  Expense.:', transactionsLib.verify(tr1), transactionsLib.verify(tr2));

      if (!transactionsLib.verify(credit)) {
        console.log(`| EDAU | CREDIT | ${credit.id} | ${credit.TransactionGroup} | ${transactionsLib.difference(credit)} |`);
      }
      if (!transactionsLib.verify(debit)) {
        console.log(`| EDAU  | DEBIT | ${debit.id} | ${debit.TransactionGroup}  | ${transactionsLib.difference(debit)}  |`);
      }
    } else if (tr1.OrderId !== null) {
      this.ensureHostCurrencyFxRate(credit);
      this.ensureHostCurrencyFxRate(debit);
      this.rewriteFees(credit, debit);

      // Both CREDIT & DEBIT transactions add up
      if (transactionsLib.verify(credit) && transactionsLib.verify(debit)) {
        console.log('Order...: true, true');
        return;
      }

      // Something is off
      console.log('  Order...:', transactionsLib.verify(credit), transactionsLib.verify(debit));
      if (!this.hasFees(tr1) && !this.hasFees(tr2)) {
        console.log('    No fees, skipping');
        return;
      }

      this.rewriteFeesAndNetAmount(credit, debit);

      if (!transactionsLib.verify(credit)) {
        console.log(`| ODAU | CREDIT | ${credit.id} | ${credit.TransactionGroup} | ${transactionsLib.difference(credit)} |`);
      }
      if (!transactionsLib.verify(debit)) {
        console.log(`| ODAU | DEBIT  | ${debit.id}  | ${debit.TransactionGroup}  | ${transactionsLib.difference(debit)}  |`);
      }

      // if (!credit.hostFeeInHostCurrency)
      //   console.log('    * WARNING: C:hostFee.....: ', credit.hostFeeInHostCurrency);
      // if (!credit.platformFeeInHostCurrency)
      //   console.log('    * WARNING: C:platformFee.: ', credit.platformFeeInHostCurrency);
      // if (!credit.paymentProcessorFeeInHostCurrency)
      //   console.log('    * WARNING: C:ppFee.......: ', credit.paymentProcessorFeeInHostCurrency);
    } else {
      console.log('  WAT.....:', transactionsLib.verify(tr1), transactionsLib.verify(tr2));
    }

    // console.log('    * C:amount......: ', credit.amountInHostCurrency);
    // console.log('    * C:netAmount...: ', credit.netAmountInCollectiveCurrency);
    // console.log('    * C:hostFee.....: ', credit.hostFeeInHostCurrency);
    // console.log('    * C:platformFee.: ', credit.platformFeeInHostCurrency);
    // console.log('    * C:ppFee.......: ', credit.paymentProcessorFeeInHostCurrency);

    // console.log('    * D:amount......: ', debit.amountInHostCurrency);
    // console.log('    * D:netAmount...: ', debit.netAmountInCollectiveCurrency);
    // console.log('    * D:hostFee.....: ', debit.hostFeeInHostCurrency);
    // console.log('    * D:platformFee.: ', debit.platformFeeInHostCurrency);
    // console.log('    * D:ppFee.......: ', debit.paymentProcessorFeeInHostCurrency);
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
  parser.addArgument(['-q', '--quiet'], {
    help: 'Silence output',
    defaultValue: true,
    action: 'storeConst',
    constant: false
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
    verbose: !args.quiet,
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
