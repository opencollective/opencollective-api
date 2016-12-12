import {
  GraphQLNonNull,
  GraphQLString,
  GraphQLInt
} from 'graphql';

import CustomGraphQLDateType from 'graphql-custom-datetype';

import models from '../models';
import {
  EventType
} from './types';

const mutations = {
  addEvent: {
    type: EventType,
    args: {
      name: {
        type: new GraphQLNonNull(GraphQLString),
      },
      description: {
        type: new GraphQLNonNull(GraphQLString),
      },
      groupSlug: {
        type: new GraphQLNonNull(GraphQLString),
      },
      locationString: {
        type: GraphQLString,
      },
      startsAt: {
        type: new GraphQLNonNull(CustomGraphQLDateType),
      },
      endsAt: {
        type: CustomGraphQLDateType,
      },
      maxAmount: {
        type: GraphQLInt,
      },
      currency: {
        type: GraphQLString,
      }
    },
    resolve(_, args) {
      return models.Group.findOne({slug: args.groupSlug})
      .then(group => {
        if (!group) {
          return new Error(`Can't find collective with slug '${groupSlug}'`)
        } else {
          // TODO: add createdBy after authentication
          args.GroupId = group.id;
          args.slug = args.name.replace(/ /g,'-');
          return models.Event.count({
            where: {
              GroupId: group.id,
              slug: { $like: `${args.slug}%`}
            }
          })
          .then(numEventsWithSlug => {
            args.slug = (numEventsWithSlug === 0) ? args.slug : `${args.slug}-${numEventsWithSlug}`;
          })
          .then(() => models.Event.create(args))
        }
      })
    }
  }
}

export default mutations;
