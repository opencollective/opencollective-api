import { GraphQLIndividual } from '../object/Individual';

import { buildAccountQuery } from './AccountQuery';

const IndividualQuery = buildAccountQuery({ objectType: GraphQLIndividual });

export default IndividualQuery;
