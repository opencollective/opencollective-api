import { Event } from '../object/Event';

import { buildAccountQuery } from './AccountQuery';

const EventQuery = buildAccountQuery({ objectType: Event });

export default EventQuery;
