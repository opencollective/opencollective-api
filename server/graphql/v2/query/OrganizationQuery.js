import { Organization } from '../object/Organization';

import { buildAccountQuery } from './AccountQuery';

const OrganizationQuery = buildAccountQuery({ objectType: Organization });

export default OrganizationQuery;
