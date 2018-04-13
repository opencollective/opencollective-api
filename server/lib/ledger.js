/** @module lib/ledger */

import models from '../models';

export async function rows(TransactionGroup) {
  return models.Transaction.findAll({
    where: { TransactionGroup }
  });
}

/** Aggregate amount fields of array of transactions
 *
 * @param {number} id is the id of the ledger's Collective that will
 *  have the balance formatted. This works for any type of collective:
 *  Users, Collectives, & Hosts.
 * @param {models.Transaction[]} rows is the array of transaction rows
 *  that the balance will be calculated from.
 * @return {Object} with currencies as keys and amounts as values.
 * @example
 * > const rows = await libledger.rows('7300e56b-09c4-4e8a-8c11-cd17cf7fdd3b');
 * > balance(userCollective.id, rows)
 * { USD: 50, MXN: 922 }
 */
export function balance(id, rows) {
  const { currency, fromCurrency } = rows[0].dataValues;
  const initial = { [currency]: 0, [fromCurrency]: 0 };
  return rows
    .filter(x => x.CollectiveId === id)
    .reduce((a, b) => {
      a[currency] += b.amount;
      // Prevent from accounting for the same value twice
      if (currency !== fromCurrency) {
        a[fromCurrency] += b.fromAmount;
      }
      return a;
    }, initial);
}

/**
 * Format the balance of the "left side" of a collective ledger
 *
 * This function will aggregate the value of the field `amount` in the
 * `Transactions` table. Which means that it will use whatever
 * currency was accepted by the host when the transaction was created.
 *
 * @param {number} id is the id of the ledger's Collective that will
 *  have the balance formatted. This works for any type of collective:
 *  Users, Collectives, & Hosts.
 * @param {models.Transaction[]} rows is the array of transaction rows
 *  that the balance will be calculated from.
 * @return {string} with value and currency concatenated.
 */
export function formattedBalance(id, rows) {
  const { currency } = rows[0].dataValues;
  const sum = balance(id, rows);
  return `${sum[currency]} ${currency}`;
}

/**
 * Format the balance of the "left side" of a User's collective ledger
 *
 * This function will aggregate the value of the field `fromAmount` in
 * the `Transactions` table. Which means that *it will use whatever
 * currency the User used when the transaction was created*.
 *
 * @param {number} id is the id of the ledger's Collective that will
 *  have the balance formatted. This works for any type of collective:
 *  Users, Collectives, & Hosts.
 * @param {models.Transaction[]} rows is the array of transaction rows
 *  that the balance will be calculated from.
 * @return {string} with value and currency concatenated.
 */
export function formattedBalanceFromCurrency(id, rows) {
  const { fromCurrency } = rows[0].dataValues;
  const sum = balance(id, rows);
  return `${sum[fromCurrency]} ${fromCurrency}`;
}
