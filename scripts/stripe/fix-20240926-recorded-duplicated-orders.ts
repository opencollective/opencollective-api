import '../../server/env';

import { QueryTypes, Sequelize } from 'sequelize';

import { Order, sequelize as s, Transaction } from '../../server/models';

const sequelize: Sequelize = s;

const AFFECTED_ORDERS_QUERY = `
    WITH count_payment_intents AS (
        SELECT o."data"#>>'{previousPaymentIntents,0,id}' AS payment_intent_id, count(1) AS count
        FROM "Orders" o
        INNER JOIN "PaymentMethods" pm ON pm.id = o."PaymentMethodId"
        WHERE TRUE
        AND pm."service" = 'stripe'
        AND o.status = 'PAID'
        AND o."data"#>>'{previousPaymentIntents,0,id}' IS NOT NULL
        GROUP BY o."data"#>>'{previousPaymentIntents,0,id}'
    ),
    duplicated_payment_intents as (
        SELECT payment_intent_id FROM count_payment_intents WHERE count >= 2
    ),
    duplicated_orders AS (
        SELECT 
            o.id,
            duplicated_payment_intents.payment_intent_id,
            RANK () OVER ( 
                    PARTITION BY duplicated_payment_intents.payment_intent_id
                    ORDER BY o."processedAt" ASC
                ) "duplicated_number",
            o."createdAt",
            o."updatedAt",
            o."SubscriptionId",
            o."PaymentMethodId",
            o."description",
            o."processedAt",
            o."totalAmount",
            o."FromCollectiveId",
            from_collective."slug"
        FROM "Orders" o
        INNER JOIN duplicated_payment_intents ON duplicated_payment_intents.payment_intent_id = o."data"#>>'{previousPaymentIntents,0,id}'
        JOIN "Collectives" from_collective ON from_collective.id = o."FromCollectiveId"
        ORDER BY o."data"#>>'{previousPaymentIntents,0,id}', o."processedAt" ASC
    )
    SELECT * FROM duplicated_orders WHERE duplicated_number >= 2
`;

const AFFECTED_TRANSACTIONS_QUERY = `
    WITH count_payment_intents AS (
        SELECT o."data"#>>'{previousPaymentIntents,0,id}' AS payment_intent_id, count(1) AS count
        FROM "Orders" o
        INNER JOIN "PaymentMethods" pm ON pm.id = o."PaymentMethodId"
        WHERE TRUE
        AND pm."service" = 'stripe'
        AND o.status = 'PAID'
        AND o."data"#>>'{previousPaymentIntents,0,id}' IS NOT NULL
        GROUP BY o."data"#>>'{previousPaymentIntents,0,id}'
    ),
    duplicated_payment_intents as (
        SELECT payment_intent_id FROM count_payment_intents WHERE count >= 2
    ),
    duplicated_orders AS (
        SELECT 
            o.id,
            duplicated_payment_intents.payment_intent_id,
            RANK () OVER ( 
                    PARTITION BY duplicated_payment_intents.payment_intent_id
                    ORDER BY o."processedAt" ASC
                ) "duplicated_number",
            o."createdAt",
            o."updatedAt",
            o."SubscriptionId",
            o."PaymentMethodId",
            o."description",
            o."processedAt",
            o."totalAmount",
            o."FromCollectiveId",
            from_collective."slug"
        FROM "Orders" o
        INNER JOIN duplicated_payment_intents ON duplicated_payment_intents.payment_intent_id = o."data"#>>'{previousPaymentIntents,0,id}'
        JOIN "Collectives" from_collective ON from_collective.id = o."FromCollectiveId"
        ORDER BY o."data"#>>'{previousPaymentIntents,0,id}', o."processedAt" ASC
    ),
    orders_to_delete AS (
        SELECT * FROM duplicated_orders WHERE duplicated_number >= 2
    )
    SELECT t.id, t."OrderId", t."createdAt", t."type", t."kind"
    FROM "Transactions" t
    INNER JOIN orders_to_delete o ON o.id = t."OrderId" 
`;

type AffectedOrder = {
  id: number;
};

type AffectedTransaction = {
  id: number;
  OrderId: number;
  createdAt: Date;
};

const main = async () => {
  console.log(`Starting...`);
  const orders: AffectedOrder[] = await sequelize.query(AFFECTED_ORDERS_QUERY, {
    type: QueryTypes.SELECT,
  });
  console.log(`Processing ${orders.length} orders...`);

  let processedOrders = 0;
  for (const order of orders) {
    console.log(`Deleting order ${order.id}`);
    if (!process.env.DRY) {
      try {
        await Order.destroy({ where: { id: order.id } });
        processedOrders++;
      } catch (err) {
        console.error(err);
      }
    }
  }

  console.log(`Done processing ${processedOrders} orders.`);

  const transactions: AffectedTransaction[] = await sequelize.query(AFFECTED_TRANSACTIONS_QUERY, {
    type: QueryTypes.SELECT,
  });

  console.log(`Processing ${transactions.length} transactions...`);

  let processedTransactions = 0;
  for (const txn of transactions) {
    console.log(
      `Deleting transaction ${txn.id} from ${txn.createdAt.toISOString()} originated from order ${txn.OrderId}`,
    );
    if (!process.env.DRY) {
      try {
        await Transaction.destroy({ where: { id: txn.id } });
        processedTransactions++;
      } catch (err) {
        console.error(err);
      }
    }
  }

  console.log(`Done processing ${processedTransactions} transactions.`);
};

main()
  .then(() => process.exit())
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
