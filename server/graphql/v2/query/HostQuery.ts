import { GraphQLHost } from '../object/Host';

import { buildAccountQuery } from './AccountQuery';

const HostQuery = buildAccountQuery({ objectType: GraphQLHost });

export default HostQuery;
