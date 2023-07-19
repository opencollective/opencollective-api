import { GraphQLOrganization } from '../object/Organization.js';

import { buildAccountQuery } from './AccountQuery.js';

const OrganizationQuery = buildAccountQuery({ objectType: GraphQLOrganization });

export default OrganizationQuery;
