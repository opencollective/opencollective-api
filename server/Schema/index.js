import {
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLList
} from 'graphql';

import models from '../models';
import queries from './query';
import mutations from './mutation';

import {EventType} from './types';

const Query = new GraphQLObjectType({
  name: 'Query',
  description: 'This is a root query',
  fields: () => {
    return {
      getEvent: queries.getEvent,
    }
  }
});

const Mutation = new GraphQLObjectType({
  name: 'Mutation',
  description: 'Functions to write stuff',
  fields: () => {
    return {
      addOrUpdateEvent: mutations.addOrUpdateEvent,
      addOrUpdateResponse: mutations.addOrUpdateResponse
    }
  }
});

const Schema = new GraphQLSchema({
  query: Query,
  mutation: Mutation
});

export default Schema