/* eslint-disable no-console */
import fs from 'fs';
import path from 'path';

import { EntityShortIdPrefix } from '../server/lib/permalink/entity-map';

const modelsWithHistory = [
  'Collectives',
  'Comments',
  'Expense',
  'KYCVerifications',
  'Orders',
  'PlatformSubscriptions',
  'Subscriptions',
  'Tiers',
  'Updates',
  'Users',
];

const ModelsWithPublicIds = {
  AccountingCategories: EntityShortIdPrefix.AccountingCategory,
  Activities: EntityShortIdPrefix.Activity,
  Agreements: EntityShortIdPrefix.Agreement,
  Applications: EntityShortIdPrefix.Application,
  Comments: EntityShortIdPrefix.Comment,
  Collectives: EntityShortIdPrefix.Collective,
  ConnectedAccounts: EntityShortIdPrefix.ConnectedAccount,
  Conversations: EntityShortIdPrefix.Conversation,
  Expenses: EntityShortIdPrefix.Expense,
  ExpenseAttachedFiles: EntityShortIdPrefix.ExpenseAttachedFile,
  ExpenseItems: EntityShortIdPrefix.ExpenseItem,
  ExportRequests: EntityShortIdPrefix.ExportRequest,
  HostApplications: EntityShortIdPrefix.HostApplication,
  KYCVerifications: EntityShortIdPrefix.KYCVerification,
  LegalDocuments: EntityShortIdPrefix.LegalDocument,
  ManualPaymentProviders: EntityShortIdPrefix.ManualPaymentProvider,
  Members: EntityShortIdPrefix.Member,
  MemberInvitations: EntityShortIdPrefix.MemberInvitation,
  Notifications: EntityShortIdPrefix.Notification,
  OAuthAuthorizationCodes: EntityShortIdPrefix.OAuthAuthorizationCode,
  Orders: EntityShortIdPrefix.Order,
  PayoutMethods: EntityShortIdPrefix.PayoutMethod,
  PaymentMethods: EntityShortIdPrefix.PaymentMethod,
  PersonalTokens: EntityShortIdPrefix.PersonalToken,
  RecurringExpenses: EntityShortIdPrefix.RecurringExpense,
  Tiers: EntityShortIdPrefix.Tier,
  Transactions: EntityShortIdPrefix.Transaction,
  TransactionsImports: EntityShortIdPrefix.TransactionsImport,
  TransactionsImportsRows: EntityShortIdPrefix.TransactionsImportRow,
  Updates: EntityShortIdPrefix.Update,
  UploadedFiles: EntityShortIdPrefix.UploadedFile,
  Users: EntityShortIdPrefix.User,
  UserTokens: EntityShortIdPrefix.UserToken,
  UserTwoFactorMethods: EntityShortIdPrefix.UserTwoFactorMethod,
  VirtualCards: EntityShortIdPrefix.VirtualCard,
  VirtualCardRequests: EntityShortIdPrefix.VirtualCardRequest,
};

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE "KYCVerificationHistories" DROP CONSTRAINT IF EXISTS "KYCVerificationHistories_CreatedByUserId_fkey";
    `);

    const sqlScript = fs.readFileSync(path.join(__dirname, 'scripts', 'nanoid.sql'), 'utf8');

    await queryInterface.sequelize.query(sqlScript);

    await queryInterface.sequelize.query(`
      CREATE OR REPLACE FUNCTION oc_nanoid(
        prefix text
      )
        RETURNS TEXT 
        LANGUAGE plpgsql
        VOLATILE
        PARALLEL SAFE
      AS $$
      BEGIN
        IF prefix IS NULL or length(prefix) < 1 THEN
          RAISE EXCEPTION 'Prefix must be at least 1 characters long';
        END IF;
        RETURN prefix || '_' || nanoid(21, '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ');
      END;
      $$;
    `);

    for (const [tableName, nanoIdPrefix] of Object.entries(ModelsWithPublicIds)) {
      console.log(`Adding publicId column to ${tableName}`);
      await queryInterface.sequelize.query(`
        ALTER TABLE "${tableName}" ADD COLUMN IF NOT EXISTS "publicId" TEXT UNIQUE;
      `);

      console.log(`Setting default value for publicId column in ${tableName}`);
      await queryInterface.sequelize.query(`
        ALTER TABLE "${tableName}" ALTER COLUMN "publicId" SET DEFAULT oc_nanoid('${nanoIdPrefix}');
      `);

      if (modelsWithHistory.includes(tableName)) {
        console.log(`Fixing up history table ${tableName}Histories`);
        await queryInterface.sequelize.query(`
          ALTER TABLE "${tableName.slice(0, -1)}Histories" ADD COLUMN IF NOT EXISTS "publicId" TEXT;
        `);
      }

      if (['Transactions'].includes(tableName)) {
        console.log(`Skipping bulk update for ${tableName}"`);
        continue;
      }

      const [[{ count }]] = await queryInterface.sequelize.query(`
        SELECT COUNT(*) FROM "${tableName}";
      `);

      const bulkUpdateSize = 10000;
      console.log(`${count} records for ${tableName}, in ${Math.ceil(count / bulkUpdateSize)} batches`);

      for (let i = 0; i < Math.ceil(count / bulkUpdateSize); i++) {
        console.log(`Updating batch ${i + 1} of ${Math.ceil(count / bulkUpdateSize)} for ${tableName}`);
        await queryInterface.sequelize.query(`
          WITH to_update AS (
            SELECT "id" FROM "${tableName}" WHERE "publicId" IS NULL LIMIT ${bulkUpdateSize}
          )
          UPDATE "${tableName}" SET "publicId" = oc_nanoid('${nanoIdPrefix}')
          WHERE "id" IN (SELECT "id" FROM to_update);
        `);
      }

      try {
        await queryInterface.sequelize.query(`
          ALTER TABLE "${tableName}" ALTER COLUMN "publicId" SET NOT NULL;
        `);
      } catch (error) {
        console.log(`Error setting not null constraint for publicId column in ${tableName}: ${error}`);
      }
    }
  },

  async down(queryInterface) {
    for (const [tableName] of Object.entries(ModelsWithPublicIds)) {
      console.log(`Dropping publicId column from ${tableName}`);
      await queryInterface.sequelize.query(`
          ALTER TABLE "${tableName}" DROP COLUMN "publicId";
        `);
    }

    await queryInterface.sequelize.query(`
      DROP FUNCTION IF EXISTS oc_nanoid(text);
      DROP FUNCTION IF EXISTS nanoid(int, text, float);
      DROP FUNCTION IF EXISTS nanoid_optimized(int, text, int, int);
    `);
  },
};
