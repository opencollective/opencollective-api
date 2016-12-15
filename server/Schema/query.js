import {
  GraphQLBoolean,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString
} from 'graphql';

import {
  EventType
} from './types';

import {
  EventInputType
} from './inputTypes';

import models from '../models';

const queries = {
  getEvent: {
    type: new GraphQLList(EventType),
    args: {
      slug: {
        type: GraphQLString
      },
      groupSlug: {
        type: GraphQLString
      }
    },
    resolve(_, args) {
      return models.Event.findAll({
        where: {
          slug: args.slug
        },
        include: [{
          model: models.Group,
          where: { slug: args.groupSlug }
        }]
      })
    }
  },
  getAnyEvent: {
    type: new GraphQLList(EventType),
    args: {
      event: {
        type: EventInputType
      }
    },
    resolve(_, args) {
      return models.Event.findAll({where: args})
    }
  }
}

export default queries;
