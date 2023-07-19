import { GraphQLIndividual } from '../object/Individual.js';

import { buildAccountQuery } from './AccountQuery.js';

const IndividualQuery = buildAccountQuery({ objectType: GraphQLIndividual });

export default IndividualQuery;
