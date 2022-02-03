import { Fund } from '../object/Fund';

import { buildAccountQuery } from './AccountQuery';

const FundQuery = buildAccountQuery({ objectType: Fund });

export default FundQuery;
