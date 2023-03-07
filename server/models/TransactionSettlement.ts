import { groupBy } from 'lodash';
import {
  BelongsToGetAssociationMixin,
  CreationOptional,
  ForeignKey,
  InferAttributes,
  InferCreationAttributes,
  QueryTypes,
} from 'sequelize';

import expenseType from '../constants/expense_type';
import { TransactionKind } from '../constants/transaction-kind';
import sequelize, { DataTypes, Model, Op, Transaction as SQLTransaction } from '../lib/sequelize';

import Collective from './Collective';
import Expense from './Expense';
import Transaction from './Transaction';

export enum TransactionSettlementStatus {
  OWED = 'OWED',
  INVOICED = 'INVOICED',
  SETTLED = 'SETTLED',
}

class TransactionSettlement extends Model<
  InferAttributes<TransactionSettlement>,
  InferCreationAttributes<TransactionSettlement>
> {
  public declare TransactionGroup: string;
  public declare kind: TransactionKind;
  public declare status: TransactionSettlementStatus;
  public declare ExpenseId: ForeignKey<Expense['id']>;
  public declare createdAt: CreationOptional<Date>;
  public declare updatedAt: CreationOptional<Date>;
  public declare deletedAt: CreationOptional<Date>;

  public declare getExpense: BelongsToGetAssociationMixin<Expense>;

  // ---- Static methods ----

  static async getAccountsWithOwedSettlements(): Promise<(typeof Collective)[]> {
    return sequelize.query(
      `
        SELECT c.*
        FROM "Collectives" c
        INNER JOIN "Transactions" t ON t."CollectiveId" = c.id
        INNER JOIN "TransactionSettlements" ts
          ON t."TransactionGroup" = ts."TransactionGroup"
          AND t."kind" = ts."kind"
        WHERE t."type" = 'CREDIT'
        AND t."isDebt" IS TRUE
        AND t."deletedAt" IS NULL
        AND ts."deletedAt" IS NULL
        AND ts."status" = 'OWED'
        GROUP BY c.id
      `,
      {
        model: Collective,
        mapToModel: true,
      },
    );
  }

  static async getHostDebts(
    hostId: number,
    settlementStatus: TransactionSettlementStatus = undefined,
  ): Promise<(typeof Transaction)[]> {
    return sequelize.query(
      `
        SELECT t.*, ts.status as "settlementStatus"
        FROM "Transactions" t
        INNER JOIN "TransactionSettlements" ts
          ON t."TransactionGroup" = ts."TransactionGroup"
          AND t."kind" = ts."kind"
        WHERE t."type" = 'CREDIT'
        AND t."isDebt" IS TRUE
        AND t."deletedAt" IS NULL
        AND ts."deletedAt" IS NULL
        ${settlementStatus ? 'AND ts."status" = :settlementStatus' : ''}
        ORDER BY "id" ASC
      `,
      {
        model: Transaction,
        mapToModel: true,
        replacements: { settlementStatus, hostId },
      },
    );
  }

  static async markExpenseAsSettled(expense: Expense): Promise<void> {
    if (expense.type !== expenseType.SETTLEMENT && !expense.data?.['isPlatformTipSettlement']) {
      throw new Error('This function can only be used with platform tips settlements');
    }

    await TransactionSettlement.update(
      { status: TransactionSettlementStatus.SETTLED },
      { where: { ExpenseId: expense.id } },
    );
  }

  /**
   * Update
   */
  static async updateTransactionsSettlementStatus(
    transactions: (typeof Transaction)[],
    status: TransactionSettlementStatus,
    expenseId: number = undefined,
  ): Promise<void> {
    const newData = { status };
    if (expenseId !== undefined) {
      newData['ExpenseId'] = expenseId;
    }

    await TransactionSettlement.update(newData, {
      where: {
        [Op.or]: transactions.map(transaction => ({
          TransactionGroup: transaction.TransactionGroup,
          kind: transaction.kind,
        })),
      },
    });
  }

  static async markTransactionsAsInvoiced(transactions: (typeof Transaction)[], expenseId: number): Promise<void> {
    return TransactionSettlement.updateTransactionsSettlementStatus(
      transactions,
      TransactionSettlementStatus.INVOICED,
      expenseId,
    );
  }

  static async createForTransaction(
    transaction: typeof Transaction,
    status = TransactionSettlementStatus.OWED,
    sqlTransaction: SQLTransaction = null,
  ): Promise<void> {
    // For some reason, using `TransactionSettlement.create` returns an error like `column "id" of relation "TransactionSettlements" does not exist`
    // in some cases. That is probably related to the fact Sequelize does not handle multi-keys indexes properly.
    await sequelize.query(
      `
        INSERT INTO "TransactionSettlements" ("TransactionGroup", "kind", "status", "createdAt", "updatedAt")
        VALUES (:TransactionGroup, :kind, :status, NOW(), NOW())
      `,
      {
        type: QueryTypes.INSERT,
        model: TransactionSettlement,
        mapToModel: true,
        transaction: sqlTransaction,
        replacements: {
          TransactionGroup: transaction.TransactionGroup,
          kind: transaction.kind,
          status,
        },
      },
    );
  }

  static async getByTransaction(transaction: typeof Transaction): Promise<TransactionSettlement> {
    return TransactionSettlement.findOne({
      where: { TransactionGroup: transaction.TransactionGroup, kind: transaction.kind },
    });
  }

  static async attachStatusesToTransactions(transactions: (typeof Transaction)[]): Promise<void> {
    const debts = transactions.filter(t => t.isDebt);
    const where = { [Op.or]: debts.map(t => ({ TransactionGroup: t.TransactionGroup, kind: t.kind })) };
    const settlements = await TransactionSettlement.findAll({ where });
    const groupedSettlements = groupBy(settlements, 'TransactionGroup');

    debts.forEach(transaction => {
      const settlement = groupedSettlements[transaction.TransactionGroup]?.find(s => transaction.kind === s.kind);
      transaction['dataValues']['settlementStatus'] = settlement?.status || null;
    });
  }
}

TransactionSettlement.init(
  {
    TransactionGroup: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    kind: {
      // Re-using the same ENUM than `Transactions` so that we don't have to maintain two of them.
      // We'll have a better way of doing this with https://github.com/sequelize/sequelize/issues/2577
      type: '"public"."enum_Transactions_kind"',
      allowNull: false,
    },
    status: {
      type: DataTypes.ENUM(...Object.values(TransactionSettlementStatus)),
      allowNull: false,
    },
    ExpenseId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: 'Expenses', key: 'id' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
    },
    createdAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
      allowNull: false,
    },
    updatedAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
      allowNull: false,
    },
    deletedAt: {
      type: DataTypes.DATE,
    },
  },
  {
    sequelize,
    tableName: 'TransactionSettlements',
    paranoid: true,
  },
);

TransactionSettlement.removeAttribute('id');

export default TransactionSettlement;
