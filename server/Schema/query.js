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
    resolve(root, {slug, groupSlug}) {
      return models.Event.findAll({
        where: {
          slug: slug
        },
        include: [{
          model: models.Group,
          where: { slug: groupSlug }
        }]
      })
    }
  }
}

export default queries;
