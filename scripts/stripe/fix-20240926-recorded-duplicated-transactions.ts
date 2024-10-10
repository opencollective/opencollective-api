import '../../server/env';

import { QueryTypes, Sequelize } from 'sequelize';

import { Order, sequelize as s, Subscription, Transaction } from '../../server/models';

const sequelize: Sequelize = s;

const AFFECTED_TRANSACTIONS = `
    WITH count_charge_ids AS (
        SELECT t."data"#>>'{charge,id}' AS charge_id, count(1) as count
        FROM "Transactions" t
        WHERE TRUE
        AND t."data"#>>'{charge,id}' IS NOT NULL
        AND t."deletedAt" IS NULL
        AND t."kind" = 'CONTRIBUTION'
        AND t."type" = 'CREDIT'
        AND NOT t."isRefund"
        GROUP BY t."data"#>>'{charge,id}'
    ),
    duplicated_charge_ids AS (
        SELECT charge_id FROM count_charge_ids WHERE count >= 2
    ),
    duplicated_transactions AS (
        SELECT 
            t.id,
            duplicated_charge_ids.charge_id,
            RANK () OVER ( 
                    PARTITION BY duplicated_charge_ids.charge_id
                    ORDER BY t."createdAt" ASC
                ) "duplicated_number",
            t."createdAt",
            t."updatedAt",
            t."OrderId",
            t."ExpenseId",
            t."TransactionGroup",
            t."description",
            t."amount",
            t."FromCollectiveId",
            from_collective."slug" as "FromCollective.slug",
            host."slug" as "Host.slug",
            o."createdAt" as "Order.createdAt",
            o."updatedAt" as "Order.updatedAt",
            o."deletedAt" as "Order.deletedAt",
            o."status" as "Order.status",
            o."SubscriptionId" as "SubscriptionId"
        FROM "Transactions" t
        INNER JOIN duplicated_charge_ids ON duplicated_charge_ids.charge_id = t."data"#>>'{charge,id}'
        LEFT JOIN "Orders" o ON o.id = t."OrderId"
        LEFT JOIN "Collectives" from_collective ON from_collective.id = t."FromCollectiveId"
        LEFT JOIN "Collectives" host ON host.id = t."HostCollectiveId"
        WHERE TRUE
        AND t."deletedAt" IS NULL
        AND t."type" = 'CREDIT'
        AND t."kind" = 'CONTRIBUTION'
        AND NOT t."isRefund"
        ORDER BY t."data"#>>'{charge,id}', t."createdAt" ASC
    )
    select * from duplicated_transactions
    WHERE DATE_TRUNC('day', "createdAt") = '2024-09-26'
    AND duplicated_number >= 2
`;

type AffectedTransaction = {
  id: number;
  OrderId: number;
  TransactionGroup: string;
  SubscriptionId: number;
};

const IS_DRY = process.env.DRY;

const main = async () => {
  console.log(`Starting...`);
  console.log(`Querying affected transactions...`);
  const transactions: AffectedTransaction[] = await sequelize.query(AFFECTED_TRANSACTIONS, {
    type: QueryTypes.SELECT,
  });

  console.log(`${transactions.length} duplicated CREDIT CONTRIBUTION transactions...`);

  let affectedTransactions = 0;
  let processedTransactions = 0;

  let affectedOrders = 0;
  let processedOrders = 0;

  let affectedSubscriptions = 0;
  let processedSubscriptions = 0;

  for (const transaction of transactions) {
    const transactionGroup = await Transaction.findAll({
      where: {
        TransactionGroup: transaction.TransactionGroup,
      },
    });

    for (const transactionInGroup of transactionGroup) {
      affectedTransactions += 1;
      if (!IS_DRY) {
        await transactionInGroup.destroy();
        processedTransactions += 1;
      }
    }

    const order = transaction.OrderId && (await Order.findByPk(transaction.OrderId));
    if (order) {
      affectedOrders += 1;
      if (!IS_DRY) {
        await order.destroy();
        processedOrders += 1;
      }
    }

    const subscription = transaction.SubscriptionId && (await Subscription.findByPk(transaction.SubscriptionId));
    if (subscription) {
      affectedSubscriptions += 1;
      if (!IS_DRY) {
        await subscription.destroy();
        processedSubscriptions += 1;
      }
    }
  }

  console.log(`Done processing ${processedOrders}/${affectedOrders} orders.`);
  console.log(`Done processing ${processedTransactions}/${affectedTransactions} transactions.`);
  console.log(`Done processing ${processedSubscriptions}/${affectedSubscriptions} subscriptions.`);
};

main()
  .then(() => process.exit())
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
