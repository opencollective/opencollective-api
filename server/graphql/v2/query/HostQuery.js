import { Host } from '../object/Host';

import { buildAccountQuery } from './AccountQuery';

const HostQuery = buildAccountQuery({ objectType: Host });

export default HostQuery;
