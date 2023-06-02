import { GraphQLOrganization } from '../object/Organization';

import { buildAccountQuery } from './AccountQuery';

const OrganizationQuery = buildAccountQuery({ objectType: GraphQLOrganization });

export default OrganizationQuery;
