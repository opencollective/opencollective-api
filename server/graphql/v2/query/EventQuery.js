import { GraphQLEvent } from '../object/Event.js';

import { buildAccountQuery } from './AccountQuery.js';

const EventQuery = buildAccountQuery({ objectType: GraphQLEvent });

export default EventQuery;
