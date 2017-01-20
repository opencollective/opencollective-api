import {
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLList
} from 'graphql';

import models from '../models';
import query from './query';
import mutation from './mutation';

import {EventType} from './types';

const Query = new GraphQLObjectType({
  name: 'Query',
  description: 'This is a root query',
  fields: () => {
    return {
      getEvent: query.getEvent,
      //getAnyEvent: query.getAnyEvent
    }
  }
});

const Mutation = new GraphQLObjectType({
  name: 'Mutation',
  description: 'Functions to write stuff',
  fields: () => {
    return {
      addOrUpdateEvent: mutation.addOrUpdateEvent,
      addOrUpdateResponse: mutation.addOrUpdateResponse
    }
  }
});

const Schema = new GraphQLSchema({
  query: Query,
  mutation: Mutation
});

export default Schema