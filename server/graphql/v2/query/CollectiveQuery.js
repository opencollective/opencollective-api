import { GraphQLCollective } from '../object/Collective.js';

import { buildAccountQuery } from './AccountQuery.js';

const CollectiveQuery = buildAccountQuery({ objectType: GraphQLCollective });

export default CollectiveQuery;
