import {
  GraphQLNonNull,
  GraphQLString,
  GraphQLInt
} from 'graphql';

import models from '../models';
import {
  EventType
} from './types';

import { hasRole } from '../middleware/security/auth';
import {HOST, MEMBER} from '../constants/roles';

const mutations = {
  addOrUpdateEvent: {
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
        type: new GraphQLNonNull(GraphQLString),
      },
      endsAt: {
        type: GraphQLString,
      },
      maxAmount: {
        type: GraphQLInt,
      },
      currency: {
        type: GraphQLString,
      }
    },
    resolve(_, args, context) {
      let group;
      return models.Group.findOne({where: {slug: args.groupSlug}})
      .then(result => {
        if (!result) {
          throw new Error(`No collective with slug '${args.groupSlug}'`);
        } else {
          group = result;
        }
      })
      .then(() => hasRole(context.remoteUser.id, group.id, [HOST, MEMBER]))
      .then(hasRole => {
        if (!hasRole) {
          throw new Error('You must be a HOST or MEMBER to create an event');
        }
        Promise.resolve();
      })
      .then(() => {
        args.createdBy = context.remoteUser.id;
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
      })
    }
  }
}

export default mutations;
