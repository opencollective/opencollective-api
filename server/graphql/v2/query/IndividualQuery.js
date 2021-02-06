import { Individual } from '../object/Individual';

import { buildAccountQuery } from './AccountQuery';

const IndividualQuery = buildAccountQuery({ objectType: Individual });

export default IndividualQuery;
