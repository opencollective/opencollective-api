import '../server/env';

import { Command } from 'commander';
import config from 'config';

import channels from '../server/constants/channels';
import models, { Op, sequelize } from '../server/models';

import { confirm } from './common/helpers';

export const testStripeAccounts = {
  // Open Source Collective 501c6
  opensource: {
    service: 'stripe',
    username: 'acct_17GUlBGSh14qHxZK',
    token: 'sk_test_DVhbUwvSoAvDfjlTRE0IrSPs',
    data: {
      publishableKey: 'pk_test_gwOTnKFLVpiYhsbXXfZcLPtR',
    },
    CollectiveId: 11004,
  },
  opensourceDvl: {
    // legacy for opencollective_dvl.pgsql
    service: 'stripe',
    username: 'acct_17GUlBGSh14qHxZK',
    token: 'sk_test_DVhbUwvSoAvDfjlTRE0IrSPs',
    data: {
      publishableKey: 'pk_test_gwOTnKFLVpiYhsbXXfZcLPtR',
    },
    CollectiveId: 9805,
  },
  // Open Collective Inc. host for meetups
  other: {
    service: 'stripe',
    username: 'acct_17GUlBGSh14qHxZK',
    token: 'sk_test_DVhbUwvSoAvDfjlTRE0IrSPs',
    data: {
      publishableKey: 'pk_test_gwOTnKFLVpiYhsbXXfZcLPtR',
    },
    CollectiveId: 8674,
  },
  brussesltogether: {
    service: 'stripe',
    username: 'acct_198T7jD8MNtzsDcg',
    token: 'sk_test_Hcsz2JJdMzEsU28c6I8TyYYK',
    data: {
      publishableKey: 'pk_test_OSQ8IaRSyLe9FVHMivgRjQng',
    },
    CollectiveId: 9802,
  },
} as const;

const createConnectedAccount = async (hostname: keyof typeof testStripeAccounts) => {
  const host = await models.Collective.findByPk(testStripeAccounts[hostname].CollectiveId);
  if (!host) {
    return;
  }

  return models.ConnectedAccount.create(testStripeAccounts[hostname]).catch(e => {
    // will fail if the host is not present
    console.log(`[warning] Unable to create a connected account for ${hostname}`);
    if (process.env.DEBUG) {
      console.error(e);
    }
  });
};

const replaceHostStripeTokens = () => {
  return models.ConnectedAccount.destroy({
    where: sequelize.literal(
      `service = 'stripe'
      AND (
        data->>'publishableKey' IS NULL
        OR data->>'publishableKey' NOT ILIKE 'pk_test_%'
      )`,
    ),
    force: true,
  })
    .then(() => createConnectedAccount('opensource'))
    .then(() => createConnectedAccount('opensourceDvl'))
    .then(() => createConnectedAccount('other'))
    .then(() => createConnectedAccount('brussesltogether'))
    .catch(e => console.error('There was an error replacing the hosts stripe tokens. Please do it manually', e));
};

const replaceUsersStripeTokens = () => {
  return models.PaymentMethod.update(
    { token: 'tok_mastercard' },
    { where: { service: 'stripe' }, paranoid: false },
  ).catch(e => console.error("Can't remove users stripe tokens. Please do it manually", e));
};

const replacePaypalTokens = () => {
  return models.PaymentMethod.update(
    { name: null, token: null, data: null },
    { where: { service: 'paypal' }, paranoid: false },
  ).catch(e => console.error("Can't remove users paypal tokens. Please do it manually", e));
};

const sanitizePayoutMethods = async () => {
  try {
    // Sanitize email + content
    await sequelize.query(
      `UPDATE "PayoutMethods" SET "data" = JSONB_SET('{}', '{email}', '"test@example.com"') WHERE data ->> 'email' IS NOT NULL`,
    );
    await sequelize.query(
      `UPDATE "PayoutMethods" SET "data" = JSONB_SET('{}', '{content}', '"Bank account info"') WHERE data ->> 'content' IS NOT NULL`,
    );

    // Omit all other fields
    await sequelize.query(
      `UPDATE "PayoutMethods"
       SET "data" = JSONB_BUILD_OBJECT(
        'currency', data ->> 'currency',
        'content', data ->> 'content'
      ) WHERE data ->> 'content' IS NOT NULL`,
    );
  } catch (e) {
    console.error("Can't sanitize payout methods. Please do it manually", e);
  }
};

const sanitizeOtherPrivateInformation = async () => {
  try {
    // Comments
    await sequelize.query(
      `UPDATE "Comments" SET "html" = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.'`,
    );

    // Expenses
    await sequelize.query(
      `UPDATE "Expenses" SET "privateMessage" = 'Lorem ipsum', "invoiceInfo" = 'Lorem ipsum', "reference" = 'Lorem ipsum'`,
    );

    // User Model
    await sequelize.query(
      `UPDATE "Users" SET 
        "emailWaitingForValidation" = NULL,
        "emailConfirmationToken" = NULL,
        "twoFactorAuthToken" = NULL,
        "yubikeyDeviceId" = NULL,
        "twoFactorAuthRecoveryCodes" = NULL,
        "passwordHash" = '$2b$10$dummy.hash.for.testing.purposes.only',
        "data" = JSONB_SET(
          JSONB_SET(
            COALESCE("data", '{}'),
            '{creationRequest,ip}', '"0.0.0.0"'
          ),
          '{lastSignInRequest,ip}', '"0.0.0.0"'
        )
      WHERE "emailWaitingForValidation" IS NOT NULL 
         OR "emailConfirmationToken" IS NOT NULL 
         OR "twoFactorAuthToken" IS NOT NULL 
         OR "yubikeyDeviceId" IS NOT NULL 
         OR "twoFactorAuthRecoveryCodes" IS NOT NULL 
         OR "passwordHash" IS NOT NULL
         OR "data" ? 'creationRequest' 
         OR "data" ? 'lastSignInRequest'`,
    );

    // Sanitize user emails (only if not already @opencollective.com)
    await sequelize.query(
      `UPDATE "Users" SET "email" = 'user-' || "id" || '-sanitized@opencollective.com'
       WHERE "email" NOT LIKE '%@opencollective.com'`,
    );

    // Collective Model
    await sequelize.query(
      `UPDATE "Collectives" SET 
        "data" = "data" - 'address' - 'replyToEmail' - 'vendorInfo'
      WHERE "data" ? 'address' OR "data" ? 'replyToEmail' OR "data" ? 'vendorInfo'`,
    );

    await sequelize.query(
      `UPDATE "Collectives" SET 
        "settings" = JSONB_SET(
          JSONB_SET(
            JSONB_SET(
              COALESCE("settings", '{}'),
              '{customEmailMessage}', '"Lorem ipsum dolor sit amet, consectetur adipiscing elit."'
            ),
            '{VAT,number}', '"EU000011111"'
          ),
          '{GST,number}', '"123456789"'
        )
      WHERE "settings" ? 'customEmailMessage' OR "settings" ? 'VAT' OR "settings" ? 'GST'`,
    );

    await sequelize.query(
      `UPDATE "Collectives" SET 
        "settings" = JSONB_SET(COALESCE("settings", '{}'), '{EIN,number}', '"000-00-0000"')
      WHERE "settings" ? 'EIN'`,
    );

    // Location Model
    await sequelize.query(
      `UPDATE "Locations" SET 
        "address" = '123 Main Street, San Francisco, CA 94105, USA',
        "structured" = NULL,
        "geoLocationLatLong" = NULL
      WHERE "address" IS NOT NULL OR "structured" IS NOT NULL OR "geoLocationLatLong" IS NOT NULL`,
    );

    // Update Model - sanitize HTML for private updates
    await sequelize.query(
      `UPDATE "Updates" SET "html" = '<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.</p>'
       WHERE "isPrivate" = true AND "html" IS NOT NULL`,
    );

    // Expense Model - additional fields
    await sequelize.query(`UPDATE "Expenses" SET "payeeLocation" = NULL WHERE "payeeLocation" IS NOT NULL`);

    await sequelize.query(
      `UPDATE "Expenses" SET 
        "data" = JSONB_SET(
          JSONB_SET(
            "data" - 'payout_item' - 'recipient',
            '{payee,email}', '"payee@staging.opencollective.com"'
          ),
          '{payee,name}', '"Payee Name"'
        )
      WHERE "data" ? 'payee' OR "data" ? 'payout_item' OR "data" ? 'recipient'`,
    );

    // PaymentMethod Model
    await sequelize.query(
      `UPDATE "PaymentMethods" SET 
        "customerId" = NULL,
        "data" = '{}'
      WHERE "customerId" IS NOT NULL OR "data" IS NOT NULL`,
    );

    // ConnectedAccount Model
    await sequelize.query(
      `UPDATE "ConnectedAccounts" SET 
        "username" = 'sanitized_user',
        "token" = NULL,
        "refreshToken" = NULL,
        "clientId" = NULL,
        "data" = '{}'
      WHERE "username" IS NOT NULL OR "token" IS NOT NULL OR "refreshToken" IS NOT NULL OR "clientId" IS NOT NULL OR "data" IS NOT NULL`,
    );

    // VirtualCard Model
    await sequelize.query(
      `UPDATE "VirtualCards" SET 
        "privateData" = NULL,
        "data" = '{}'
      WHERE "privateData" IS NOT NULL OR "data" IS NOT NULL`,
    );

    // Agreement Model
    await sequelize.query(
      `UPDATE "Agreements" SET "notes" = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.'
       WHERE "notes" IS NOT NULL`,
    );

    // Delete sensitive tables entirely
    await sequelize.query(`DELETE FROM "PersonalTokens"`);
    await sequelize.query(`DELETE FROM "UserTokens"`);
    await sequelize.query(`DELETE FROM "UserTwoFactorMethods"`);
    await sequelize.query(`DELETE FROM "OAuthAuthorizationCodes"`);
    await sequelize.query(`DELETE FROM "Applications"`);
    await sequelize.query(`DELETE FROM "MemberInvitations"`);

    // Activity Model - acknowledge we're not ready for this one
    // TODO: Activity model contains complex JSONB data that may include emails, IPs, etc.
    // This requires careful analysis of the data structure before sanitization
    console.log('Note: Activity model sanitization skipped - requires detailed analysis of JSONB data structure');
  } catch (e) {
    console.error('Cannot sanitize other private information, please do it manually', e);
  }
};

// Removes all tokens from connected accounts
const removeConnectedAccountsTokens = () => {
  return models.ConnectedAccount.update(
    { token: null },
    { where: { service: { [Op.ne]: 'stripe' } }, paranoid: false },
  ).catch(e => {
    console.error("Can't remove tokens from connected accounts. Please do it manually", e);
  });
};

// Remove all webhooks to ensure we won't ping user apps
const deleteWebhooks = () => {
  return models.Notification.destroy({
    where: { channel: [channels.WEBHOOK, channels.SLACK] },
  }).catch(e => console.error('There was an error removing the webhooks. Please do it manually', e));
};

const deleteLegalDocuments = () => {
  return models.LegalDocument.destroy({ truncate: true, force: true })
    .then(() => models.RequiredLegalDocument.destroy({ truncate: true, force: true }))
    .catch(e => console.error('Cannot remove legal documents, please do it manually', e));
};

type SanitizationScope =
  | 'host-stripe'
  | 'user-stripe'
  | 'paypal-tokens'
  | 'payout-methods'
  | 'connected-accounts-tokens'
  | 'webhooks'
  | 'legal-documents'
  | 'other-private-info';

type SanitizationFunction = () => Promise<void> | Promise<unknown>;

const sanitizationScopes: Record<SanitizationScope, SanitizationFunction> = {
  'host-stripe': replaceHostStripeTokens,
  'user-stripe': replaceUsersStripeTokens,
  'paypal-tokens': replacePaypalTokens,
  'payout-methods': sanitizePayoutMethods,
  'connected-accounts-tokens': removeConnectedAccountsTokens,
  webhooks: deleteWebhooks,
  'legal-documents': deleteLegalDocuments,
  'other-private-info': sanitizeOtherPrivateInformation,
};

const sanitizeDB = async ({
  excludeScopes = [],
  onlyScopes = [],
}: {
  excludeScopes: SanitizationScope[];
  onlyScopes: SanitizationScope[];
}) => {
  let scopesToRun: SanitizationScope[] = Object.keys(sanitizationScopes) as SanitizationScope[];

  if (onlyScopes.length > 0) {
    scopesToRun = onlyScopes.filter(scope => sanitizationScopes[scope]);
  }
  if (excludeScopes.length > 0) {
    scopesToRun = scopesToRun.filter(scope => !excludeScopes.includes(scope));
  }

  const functionsToRun = scopesToRun.map(scope => sanitizationScopes[scope]);
  if (functionsToRun.length === 0) {
    console.log('No sanitization scopes to run.');
    return;
  }

  const confirmed = await confirm(
    `Are you sure you want to run sanitization for scopes in ${config.env} (${config.database.url}): ${scopesToRun.join(', ')}`,
  );
  if (!confirmed) {
    console.log('Sanitization cancelled.');
    return;
  }

  return Promise.all(functionsToRun.map(fn => fn()));
};

// Only run script if called directly (to allow unit tests)
if (!module.parent) {
  if (config.env === 'production') {
    console.log('This script is not allowed to run in production');
    process.exit(1);
  }

  const program = new Command();

  program
    .name('sanitize-db')
    .description('Sanitize database by removing sensitive information')
    .option(
      '--exclude <scopes>',
      'Comma-separated list of scopes to exclude (e.g., "host-stripe,user-stripe")',
      (value: string) => value.split(',').map(s => s.trim()) as SanitizationScope[],
    )
    .option(
      '--only-scopes <scopes>',
      'Comma-separated list of scopes to include (e.g., "host-stripe,paypal-tokens"). If specified, only these scopes will run.',
      (value: string) => value.split(',').map(s => s.trim()) as SanitizationScope[],
    )
    .parse(process.argv);

  const options = program.opts<{
    exclude?: SanitizationScope[];
    onlyScopes?: SanitizationScope[];
  }>();

  const excludeScopes = options.exclude || [];
  const onlyScopes = options.onlyScopes || [];

  // Validate scopes
  const allScopes = Object.keys(sanitizationScopes) as SanitizationScope[];
  const invalidExclude = excludeScopes.filter(scope => !allScopes.includes(scope));
  const invalidInclude = onlyScopes.filter(scope => !allScopes.includes(scope));
  const allInvalid = [...invalidExclude, ...invalidInclude];

  if (allInvalid.length > 0) {
    console.error(`Invalid scopes: ${allInvalid.join(', ')}`);
    console.error(`Valid scopes are: ${allScopes.join(', ')}`);
    process.exit(1);
  }

  sanitizeDB({ excludeScopes, onlyScopes })
    .then(() => {
      console.log('Done!');
      process.exit();
    })
    .catch(error => {
      console.error('Error during sanitization:', error);
      process.exit(1);
    });
}
