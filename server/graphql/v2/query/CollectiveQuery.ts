import { GraphQLCollective } from '../object/Collective';

import { buildAccountQuery } from './AccountQuery';

const CollectiveQuery = buildAccountQuery({ objectType: GraphQLCollective });

export default CollectiveQuery;
