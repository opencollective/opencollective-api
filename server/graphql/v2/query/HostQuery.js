import { GraphQLHost } from '../object/Host.js';

import { buildAccountQuery } from './AccountQuery.js';

const HostQuery = buildAccountQuery({ objectType: GraphQLHost });

export default HostQuery;
