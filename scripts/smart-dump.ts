import '../server/env';

import { execSync } from 'child_process';

import { Command } from 'commander';
import { readJsonSync, writeJsonSync } from 'fs-extra';
import { cloneDeepWith, compact, concat, repeat, set, uniqBy } from 'lodash';

import { md5 } from '../server/lib/utils';
import models, { Op, sequelize } from '../server/models';
import { IDENTIFIABLE_DATA_FIELDS } from '../server/models/PayoutMethod';
import { randEmail, randStr } from '../test/test-helpers/fake-data';

const program = new Command();
const nop = () => undefined;
const exec = cmd => {
  try {
    execSync(cmd, { stdio: 'inherit' });
  } catch (e) {
    console.error(e);
  }
};

const buildDependencyTree = models => {
  const tree = {};
  const modelsArray: any[] = Object.values(models);

  modelsArray.forEach(model => {
    const { tableAttributes: columns, name } = model;
    Object.values(columns).forEach((column: any) => {
      if (column.references) {
        const model = modelsArray.find(model => model.tableName === column.references.model);
        if (tree[model.name]?.[name]) {
          tree[model.name][name].push(column.fieldName);
        } else {
          set(tree, `${model.name}.${name}`, [column.fieldName]);
        }
      }
    });
  });
  return tree;
};

// {
//   Collective: {
//     Activity: [ 'CollectiveId', 'FromCollectiveId', 'HostCollectiveId' ],
//     Application: [ 'CollectiveId' ],
//     Collective: [ 'ParentCollectiveId', 'HostCollectiveId' ],
//     Comment: [ 'CollectiveId', 'FromCollectiveId' ],
//     EmojiReaction: [ 'FromCollectiveId' ],
//     ConnectedAccount: [ 'CollectiveId' ],
//     Conversation: [ 'CollectiveId', 'FromCollectiveId' ],
//     Expense: [ 'HostCollectiveId', 'FromCollectiveId', 'CollectiveId' ],
//     HostApplication: [ 'CollectiveId', 'HostCollectiveId' ],
//     LegalDocument: [ 'CollectiveId' ],
//     Member: [ 'MemberCollectiveId', 'CollectiveId' ],
//     MemberInvitation: [ 'MemberCollectiveId', 'CollectiveId' ],
//     Notification: [ 'CollectiveId' ],
//     Order: [ 'FromCollectiveId', 'CollectiveId' ],
//     PaymentMethod: [ 'CollectiveId' ],
//     PayoutMethod: [ 'CollectiveId' ],
//     PaypalProduct: [ 'CollectiveId' ],
//     RecurringExpense: [ 'CollectiveId', 'FromCollectiveId' ],
//     RequiredLegalDocument: [ 'HostCollectiveId' ],
//     Tier: [ 'CollectiveId' ],
//     Transaction: [
//       'FromCollectiveId',
//       'CollectiveId',
//       'HostCollectiveId',
//       'UsingGiftCardFromCollectiveId'
//     ],
//     Update: [ 'CollectiveId', 'FromCollectiveId' ],
//     User: [ 'CollectiveId' ],
//     VirtualCard: [ 'CollectiveId', 'HostCollectiveId' ],
//     PersonalToken: [ 'CollectiveId' ],
//     SocialLink: [ 'CollectiveId' ]
//   },
//   User: {
//     Activity: [ 'UserId' ],
//     Application: [ 'CreatedByUserId' ],
//     Collective: [ 'CreatedByUserId', 'LastEditedByUserId' ],
//     Comment: [ 'CreatedByUserId' ],
//     EmojiReaction: [ 'UserId' ],
//     ConnectedAccount: [ 'CreatedByUserId' ],
//     Conversation: [ 'CreatedByUserId' ],
//     ConversationFollower: [ 'UserId' ],
//     Expense: [ 'UserId', 'lastEditedById' ],
//     ExpenseAttachedFile: [ 'CreatedByUserId' ],
//     ExpenseItem: [ 'CreatedByUserId' ],
//     HostApplication: [ 'CreatedByUserId' ],
//     Member: [ 'CreatedByUserId' ],
//     MemberInvitation: [ 'CreatedByUserId' ],
//     MigrationLog: [ 'CreatedByUserId' ],
//     Notification: [ 'UserId' ],
//     OAuthAuthorizationCode: [ 'UserId' ],
//     Order: [ 'CreatedByUserId' ],
//     PaymentMethod: [ 'CreatedByUserId' ],
//     PayoutMethod: [ 'CreatedByUserId' ],
//     Transaction: [ 'CreatedByUserId' ],
//     Update: [ 'CreatedByUserId', 'LastEditedByUserId' ],
//     UploadedFile: [ 'CreatedByUserId' ],
//     UserToken: [ 'UserId' ],
//     VirtualCard: [ 'UserId' ],
//     PersonalToken: [ 'UserId' ]
//   },
//   UserToken: { Activity: [ 'UserTokenId' ] },
//   Transaction: {
//     Activity: [ 'TransactionId' ],
//     Transaction: [ 'RefundTransactionId' ]
//   },
//   Expense: {
//     Activity: [ 'ExpenseId' ],
//     Comment: [ 'ExpenseId' ],
//     ExpenseAttachedFile: [ 'ExpenseId' ],
//     ExpenseItem: [ 'ExpenseId' ],
//     Transaction: [ 'ExpenseId' ],
//     TransactionSettlement: [ 'ExpenseId' ]
//   },
//   Order: { Activity: [ 'OrderId' ], Transaction: [ 'OrderId' ] },
//   Update: { Comment: [ 'UpdateId' ], EmojiReaction: [ 'UpdateId' ] },
//   Conversation: {
//     Comment: [ 'ConversationId' ],
//     ConversationFollower: [ 'ConversationId' ]
//   },
//   Comment: { EmojiReaction: [ 'CommentId' ] },
//   PayoutMethod: { Expense: [ 'PayoutMethodId' ], Transaction: [ 'PayoutMethodId' ] },
//   VirtualCard: { Expense: [ 'VirtualCardId' ] },
//   RecurringExpense: { Expense: [ 'RecurringExpenseId' ] },
//   Tier: {
//     Member: [ 'TierId' ],
//     MemberInvitation: [ 'TierId' ],
//     Order: [ 'TierId' ],
//     PaypalProduct: [ 'TierId' ],
//     Update: [ 'TierId' ]
//   },
//   Application: {
//     OAuthAuthorizationCode: [ 'ApplicationId' ],
//     UserToken: [ 'ApplicationId' ]
//   },
//   Subscription: { Order: [ 'SubscriptionId' ] },
//   PaymentMethod: {
//     Order: [ 'PaymentMethodId' ],
//     PaymentMethod: [ 'SourcePaymentMethodId' ],
//     Transaction: [ 'PaymentMethodId' ]
//   },
//   PaypalProduct: { PaypalPlan: [ 'ProductId' ] }
// }
const tree = buildDependencyTree(models);

const TEST_STRIPE_ACCOUNTS = {
  // Open Source Collective 501c6
  11004: {
    service: 'stripe',
    username: 'acct_18KWlTLzdXg9xKNS',
    token: 'sk_test_iDWQubtz4ixk0FQg1csgCi6p',
    data: {
      publishableKey: 'pk_test_l7H1cDlh2AekeETfq742VJbC',
    },
  },
  9805: {
    // legacy for opencollective_dvl.pgsql
    service: 'stripe',
    username: 'acct_18KWlTLzdXg9xKNS',
    token: 'sk_test_iDWQubtz4ixk0FQg1csgCi6p',
    data: {
      publishableKey: 'pk_test_l7H1cDlh2AekeETfq742VJbC',
    },
  },
  // Open Collective Inc. host for meetups
  8674: {
    service: 'stripe',
    username: 'acct_18KWlTLzdXg9xKNS',
    token: 'sk_test_iDWQubtz4ixk0FQg1csgCi6p',
    data: {
      publishableKey: 'pk_test_l7H1cDlh2AekeETfq742VJbC',
    },
  },
  9802: {
    service: 'stripe',
    username: 'acct_198T7jD8MNtzsDcg',
    token: 'sk_test_Hcsz2JJdMzEsU28c6I8TyYYK',
    data: {
      publishableKey: 'pk_test_OSQ8IaRSyLe9FVHMivgRjQng',
    },
  },
};

const Sanitizers = {
  ConnectedAccount: values =>
    TEST_STRIPE_ACCOUNTS[values.CollectiveId] || {
      token: randStr('tok_'),
    },
  PaymentMethod: values => ({
    token: randStr('tok_'),
    customerId: randStr('cus_'),
    data: cloneDeepWith(values.data, (value, key) => {
      if (key === 'customerIdForHost') {
        return {};
      } else if (key === 'fullName') {
        return randStr('name_');
      } else if (
        ['orderID', 'payerID', 'paymentID', 'returnUrl', 'paymentToken', 'subscriptionId', 'fingerprint'].includes(
          key as string,
        )
      ) {
        return randStr();
      } else if (key === 'email') {
        return randEmail();
      }
    }),
    name: values.service === 'paypal' ? randEmail() : values.name,
  }),
  PayoutMethod: values => ({
    data: cloneDeepWith(values.data, (value, key) => {
      if (['postCode', 'firstLine', ...IDENTIFIABLE_DATA_FIELDS].includes(key as string)) {
        return randStr();
      } else if (key === 'accountHolderName') {
        return randStr('name_');
      } else if (key === 'email') {
        return randEmail();
      }
    }),
  }),
  User: values => ({
    email: randEmail(),
    twoFactorAuthToken: null,
    twoFactorAuthRecoveryCodes: null,
    passwordHash: null,
    passwordUpdatedAt: null,
    data: cloneDeepWith(values.data, (value, key) => {
      if (key === 'lastSignInRequest') {
        return {};
      }
    }),
  }),
};

const serialize = model => document => ({ ...document.dataValues, ...Sanitizers[model]?.(document.dataValues), model });

type RecipeItem = {
  model?: string;
  where?: Record<string, any>;
  dependencies?: Array<RecipeItem | string>;
  defaultDependencies?: Array<RecipeItem | string>;
  on?: string;
  from?: string;
  limit?: number;
  depth?: number;
};

const parsed = {};

const traverse = async ({ model, where, dependencies, limit, defaultDependencies, depth = 1 }: RecipeItem) => {
  const acc: any[] = [];
  let records;
  if (model && where) {
    if (!where.id && parsed[model]) {
      where.id = { [Op.notIn]: Array.from(parsed[model]) };
    }

    records = await models[model]
      .findAll({
        where,
        limit,
      })
      .then(r => r.map(serialize(model)));

    if (!parsed[model]) {
      parsed[model] = new Set(records.map(r => r.id));
    } else {
      records.forEach(r => parsed[model].add(r.id));
    }
    acc.push(...records);
  }
  // Inject default dependencies for the model
  dependencies = compact(concat(dependencies, defaultDependencies[model]));
  if (dependencies && records) {
    for (const record of records) {
      const isLast = records.indexOf(record) === records.length - 1;
      console.info(`${repeat('  │', depth - 1)}  ${isLast ? '└' : '├'} ${record.model} #${record.id}`);

      for (const d of dependencies) {
        const dependency = typeof d === 'string' ? { model: d } : d;
        const { on, from, ...dep } = dependency;
        let dWhere = dep.where || {};
        if (on) {
          dWhere[on] = record.id;
        } else if (from && record[from]) {
          dWhere.id = record[from];
        } else if (model && dep.model && tree[model][dep.model]) {
          dWhere = { ...dWhere, [Op.or]: tree[model][dep.model].map(on => ({ [on]: record.id })) };
        } else {
          continue;
        }
        acc.push(...(await traverse({ ...dep, where: dWhere, defaultDependencies, depth: depth + 1 })));
      }
    }
  }
  return uniqBy(acc, r => `${r.model}.${r.id}`);
};

program.command('dump [recipe] [env]').action(async (recipe, env) => {
  if (!sequelize.config.username.includes('readonly')) {
    console.error('Remote must be connected with read-only user!');
    process.exit(1);
  }

  if (!recipe || (recipe && !env)) {
    console.log('Using default recipe...');
    recipe = './defaultRecipe.js';
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { entries, defaultDependencies } = require(recipe);
  const hash = md5(JSON.stringify({ entries, defaultDependencies }));
  let docs = [];
  console.time('>>>Dump');
  for (const entry of entries) {
    console.log(`\n>>> Traversing DB for entry ${entries.indexOf(entry) + 1}/${entries.length}...`);
    const newdocs = await traverse({ ...entry, defaultDependencies });
    docs.push(...newdocs);
  }
  console.timeEnd('>>> Dump');

  console.log('\n>>> Deduplicating...');
  docs = uniqBy(docs, r => `${r.model}.${r.id}`);

  console.log('\n>>> Dumping JSON...');
  writeJsonSync(`dbdumps/${hash}.json`, docs, { spaces: 2 });

  console.log(`\n>>> Done! Dumped to dbdumps/${hash}.json`);
  sequelize.close();
});

program.command('restore <file>').action(async file => {
  if (sequelize.config.database !== 'opencollective_prod_snapshot') {
    console.error('Target database must be opencollective_prod_snapshot!');
    process.exit(1);
  }

  console.log(`\n>>> Reading file ${file}`);
  const docs = readJsonSync(file);

  console.log('\n>>> Recreating DB...');
  exec('dropdb opencollective_prod_snapshot');
  exec('createdb opencollective_prod_snapshot');
  await sequelize.sync().catch(nop);

  console.log('\n>>> Inserting Data...');
  for (const doc of docs) {
    const { model, ...data } = doc;
    await sequelize.models[model]
      .create(data, { validate: false, hooks: false, silent: true, logging: false })
      .catch(e => {
        console.error(e);
      });
  }

  // Ideally we would just run the migrations, but it doesn´t work because we're already creating the DB in an advanced state to make sure it is empty.
  console.log('\n>>> Creating Materaliazed Views...');
  exec(
    "PG_DATABASE=opencollective_prod_snapshot npm run db:migrate -- --name '20220510083429-create-collective-transaction-stats-materialized-view.js'",
  );
  exec(
    "PG_DATABASE=opencollective_prod_snapshot npm run db:migrate -- --name '20220510083429-create-collective-transaction-stats-materialized-view.js'",
  );
  exec(
    "PG_DATABASE=opencollective_prod_snapshot npm run db:migrate -- --name '20220623121235-transaction-balances.js'",
  );
  exec("PG_DATABASE=opencollective_prod_snapshot npm run db:migrate -- --name '20221126080358-fast-balance.js'");
  exec(
    "PG_DATABASE=opencollective_prod_snapshot npm run db:migrate -- --name '20221213000000-update-collective-transaction-stats-materialized-view.js'",
  );
  exec(
    "PG_DATABASE=opencollective_prod_snapshot npm run db:migrate -- --name '20230104225718-transaction-balances-order-by-create-date.js'",
  );
  exec(
    "PG_DATABASE=opencollective_prod_snapshot npm run db:migrate -- --name '20230125141843-create-collective-tag-stats-materialized-view.js'",
  );
  exec("PG_DATABASE=opencollective_prod_snapshot npm run db:migrate -- --name '20230213080003-fast-balance-update.js'");
  exec(
    "PG_DATABASE=opencollective_prod_snapshot npm run db:migrate -- --name '20230213094215-update-collective-transaction-stats-materialized-view.js'",
  );

  console.log('\n>>> Done!');
  sequelize.close();
});

program.addHelpText(
  'after',
  `

Example call:
  $ npm run script scripts/smart-dump.ts dump prod
  $ PG_DATABASE=opencollective_prod_snapshot npm run script scripts/smart-dump.ts restore 8f8de6ce2df1f567b6ba5ea1cdbd8250.json
`,
);

program.parse();
