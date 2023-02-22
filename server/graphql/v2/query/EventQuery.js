import { GraphQLEvent } from '../object/Event';

import { buildAccountQuery } from './AccountQuery';

const EventQuery = buildAccountQuery({ objectType: GraphQLEvent });

export default EventQuery;
