import { GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';

import { getGoCardlessInstitutions, isGoCardlessSupportedCountry } from '../../../lib/gocardless/connect';
import { GraphQLOffPlatformTransactionsProvider } from '../enum/OffPlatformTransactionsProvider';
import { GraphQLOffPlatformTransactionsInstitution } from '../object/OffPlatformTransactionsInstitution';

const OffPlatformTransactionsInstitutionsQuery = {
  type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLOffPlatformTransactionsInstitution))),
  description: 'Get financial institutions for off-platform transactions',
  args: {
    country: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'The country code to get institutions for',
    },
    provider: {
      type: new GraphQLNonNull(GraphQLOffPlatformTransactionsProvider),
      description: 'The provider to use for fetching institutions',
    },
  },
  async resolve(_, args) {
    const { country, provider } = args;

    if (provider === 'GOCARDLESS') {
      if (!isGoCardlessSupportedCountry(country)) {
        throw new Error(`Country ${country} is not supported by GoCardless`);
      }

      const institutions = await getGoCardlessInstitutions(country);

      return institutions.map(institution => ({
        id: institution.id,
        name: institution.name,
        bic: institution.bic,
        logoUrl: institution.logo,
        supportedCountries: institution.countries,
        maxAccessValidForDays: parseInt(institution.max_access_valid_for_days),
        transactionTotalDays: parseInt(institution.transaction_total_days),
      }));
    }

    throw new Error(`Provider ${provider} is not supported`);
  },
};

export default OffPlatformTransactionsInstitutionsQuery;
