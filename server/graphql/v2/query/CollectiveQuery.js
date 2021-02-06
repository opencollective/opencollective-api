import { Collective } from '../object/Collective';

import { buildAccountQuery } from './AccountQuery';

const CollectiveQuery = buildAccountQuery({ objectType: Collective });

export default CollectiveQuery;
