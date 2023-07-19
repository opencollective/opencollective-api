import { GraphQLFund } from '../object/Fund.js';

import { buildAccountQuery } from './AccountQuery.js';

const FundQuery = buildAccountQuery({ objectType: GraphQLFund });

export default FundQuery;
