import { GraphQLFund } from '../object/Fund';

import { buildAccountQuery } from './AccountQuery';

const FundQuery = buildAccountQuery({ objectType: GraphQLFund });

export default FundQuery;
