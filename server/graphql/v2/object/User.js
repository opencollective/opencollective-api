import { GraphQLBoolean, GraphQLInt, GraphQLList, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-iso-date';

import models, { Op } from '../../../models';

import { Collective } from './Collective';
import { Member } from './Member';

export const User = new GraphQLObjectType({
  name: 'UserDetails',
  description: 'This represents the details of a User',
  fields: () => {
    return {
      id: {
        type: GraphQLInt,
        resolve(user) {
          return user.id;
        },
      },
      CollectiveId: {
        type: GraphQLInt,
        resolve(user) {
          return user.CollectiveId;
        },
      },
      collective: {
        type: Collective,
        resolve(user, args, req) {
          if (!user.CollectiveId) {
            return console.error('>>> user', user.id, 'does not have a CollectiveId', user.CollectiveId);
          }
          return req.loaders.Collective.byId.load(user.CollectiveId);
        },
      },
      username: {
        type: GraphQLString,
        resolve(user) {
          return user.username;
        },
      },
      firstName: {
        type: GraphQLString,
        resolve(user) {
          return user.firstName;
        },
      },
      lastName: {
        type: GraphQLString,
        resolve(user) {
          return user.lastName;
        },
      },
      name: {
        type: GraphQLString,
        resolve(user) {
          return user.name;
        },
      },
      image: {
        type: GraphQLString,
        resolve(user) {
          return user.image;
        },
      },
      email: {
        type: GraphQLString,
        resolve(user, args, req) {
          return user.getPersonalDetails && user.getPersonalDetails(req.remoteUser).then(user => user.email);
        },
      },
      emailWaitingForValidation: {
        type: GraphQLString,
        resolve(user, args, req) {
          return (
            user.getPersonalDetails &&
            user.getPersonalDetails(req.remoteUser).then(user => user.emailWaitingForValidation)
          );
        },
      },
      memberOf: {
        type: new GraphQLList(Member),
        args: {
          roles: { type: new GraphQLList(GraphQLString) },
          includeIncognito: {
            type: GraphQLBoolean,
            defaultValue: true,
            description:
              'Whether incognito profiles should be included in the result. Only works if requesting user is an admin of the account.',
          },
        },
        resolve(user, args, req) {
          const where = { MemberCollectiveId: user.CollectiveId };
          if (args.roles && args.roles.length > 0) {
            where.role = { [Op.in]: args.roles };
          }

          const collectiveConditions = {};
          if (!args.includeIncognito || !req.remoteUser?.isAdmin(user.CollectiveId)) {
            collectiveConditions.isIncognito = false;
          }

          return models.Member.findAll({
            where,
            include: [
              {
                model: models.Collective,
                as: 'collective',
                required: true,
                where: collectiveConditions,
              },
            ],
          });
        },
      },
      isLimited: {
        type: GraphQLBoolean,
        description: "Returns true if user account is limited (user can't use any feature)",
        resolve(user) {
          return user.data && user.data.features && user.data.features.ALL === false;
        },
      },
      changelogViewDate: {
        type: GraphQLDateTime,
        resolve(user) {
          return user.changelogViewDate;
        },
      },
    };
  },
});
