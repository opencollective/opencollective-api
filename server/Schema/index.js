import {
  GraphQLObjectType,
  GraphQLSchema,
} from 'graphql';

import models from '../models';
import queries from './query';
import mutations from './mutation';

const Query = new GraphQLObjectType({
  name: 'Query',
  description: 'This is a root query',
  fields: () => {
    return {
      getEvent: queries.getEvent
    }
  }
});

const Mutation = new GraphQLObjectType({
  name: 'Mutation',
  description: 'Functions to write stuff',
  fields: () => {
    return {
      addEvent: mutations.addEvent
    }
  }
})

const Schema = new GraphQLSchema({
  query: Query,
  mutation: Mutation
});

export default Schema