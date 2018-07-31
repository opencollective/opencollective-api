import { pick } from 'lodash';

import {
  GraphQLObjectType,
  GraphQLSchema,
} from 'graphql';

import queries from './queries';

const schema = new GraphQLSchema({
  query: new GraphQLObjectType({
    name: 'Query',
    kind: 'OBJECT',
    description: "The query root of Open Collective's GraphQL's interface",
    fields: pick(queries, 'Collective', 'LoggedInUser'),
  })
});

export default schema;
