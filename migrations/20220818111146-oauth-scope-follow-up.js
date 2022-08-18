'use strict';

const previousScopes = [
  'email',
  'account',
  'expenses',
  'orders',
  'transactions',
  'virtualCards',
  'payoutMethods',
  'paymentMethods',
  'host',
  'root',
  'conversations',
  'updates',
  'webhooks',
  'applications',
  'connectedAccounts',
];

const updatedScopes = [
  'email',
  'incognito',
  'account',
  'expenses',
  'orders',
  'transactions',
  'virtualCards',
  'host',
  'root',
  'conversations',
  'updates',
  'webhooks',
  'applications',
  'connectedAccounts',
  'activities',
];

const executeQuery = async (queryInterface, query) => {
  console.log(query + '\n');
  await queryInterface.sequelize.query(query);
};

const formatEnums = values => values.map(value => `'${value}'`).join(', ');

const updateEnums = async (queryInterface, table, column, enumName, values) => {
  // See https://blog.yo1.dog/updating-enum-values-in-postgresql-the-safe-and-easy-way/
  await executeQuery(queryInterface, `ALTER TYPE "${enumName}"" RENAME TO "${enumName}_old"`);
  await executeQuery(queryInterface, `CREATE TYPE "${enumName}"" AS ENUM(${formatEnums(values)})`);
  await executeQuery(
    queryInterface,
    `ALTER TABLE "${table}" ALTER COLUMN ${column} TYPE "${enumName}"" ARRAY USING ${column}::text::${enumName}[]`,
  );
  await executeQuery(queryInterface, `DROP TYPE "${enumName}_old"`);
};

module.exports = {
  up: async queryInterface => {
    await updateEnums(
      queryInterface,
      'OAuthAuthorizationCodes',
      'scope',
      'enum_OAuthAuthorizationCodes_scope',
      updatedScopes,
    );
    await updateEnums(queryInterface, 'UserTokens', 'scope', 'enum_UserTokens_scope', updatedScopes);
  },

  down: async queryInterface => {
    await updateEnums(
      queryInterface,
      'OAuthAuthorizationCodes',
      'scope',
      'enum_OAuthAuthorizationCodes_scope',
      previousScopes,
    );
    await updateEnums(queryInterface, 'UserTokens', 'scope', 'enum_UserTokens_scope', previousScopes);
  },
};
