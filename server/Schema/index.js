import {
  GraphQLBoolean
  GraphQLInt,
  GraphQLList,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
} from 'graphql';

import models from '../models';

const User = new GraphQLObjectType({
  name: 'User',
  description: 'This represents a User',
  fields: () => {
    return {
      id: {
        type: GraphQLInt,
        resolve(user) {
          return user.id;
        }
      },
      firstName: {
        type: GraphQLString,
        resolve(user) {
          return user.firstName;
        }
      },
      lastName: {
        type: GraphQLString,
        resolve(user) {
          return user.lastName;
        }
      },
      name: {
        type: GraphQLString,
        resolve(user) {
          return `${user.firstName} ${user.lastName}`;
        }
      },
      avatar: {
        type: GraphQLString,
        resolve(user) {
          return user.avatar;
        }
      },
      username: {
        type: GraphQLString,
        resolve(user) {
          return user.username;
        }
      },
      email: {
        type: GraphQLString,
        resolve(user) {
          return user.email;
        }
      },
      isOrganization: {
        type: GraphQLBoolean,
        resolve(user) {
          return user.isOrganization;
        }
      },
      twitterHandle: {
        type: GraphQLString,
        resolve(user) {
          return user.twitterHandle;
        }
      },
      billingAddress: {
        type: GraphQLString,
        resolve(user) {
          return user.billingAddress;
        }
      },
      website: {
        type: GraphQLString,
        resolve(user) {
          return user.website;
        }
      },
      paypalEmail: {
        type: GraphQLString,
        resolve(user) {
          return user.paypalEmail;
        }
      }
    }
  }
});

const Group = new GraphQLObjectType({
  name: 'Group',
  description: 'This represents a Group',
  fields: () => {
    return {
      id: {
        type: GraphQLInt,
        resolve(group) {
          return group.id;
        }
      },
      name: {
        type: GraphQLString,
        resolve(group) {
          return group.name;
        }
      },
      description: {
        type: GraphQLString,
        resolve(group) {
          return group.description;
        }
      },
      longDescription: {
        type: GraphQLString,
        resolve(group) {
          return group.longDescription;
        }
      },
      mission: {
        type: GraphQLString,
        resolve(group) {
          return group.mission;
        }
      },
      currency: {
        type: GraphQLString,
        resolve(group) {
          return group.currency;
        }
      },
      logo: {
        type: GraphQLString,
        resolve(group) {
          return group.logo;
        }
      },
      backgroundImage: {
        type: GraphQLString,
        resolve(group) {
          return group.backgroundImage;
        }
      },
      slug: {
        type: GraphQLString,
        resolve(group) {
          return group.slug;
        }
      },
      events: {
        type: new GraphQLList(Event),
        resolve(group) {
          return group.getEvents();
        }
      }
    }
  }
});

const Event = new GraphQLObjectType({
  name: 'Event',
  description: 'This represents an Event',
  fields: () => {
    return {
      id: {
        type: GraphQLInt,
        resolve(event) {
          return event.id;
        }
      },
      name: {
        type: GraphQLString,
        resolve(event) {
          return event.name
        }
      },
      description: {
        type: GraphQLString,
        resolve(event) {
          return event.description
        }
      },
      createdBy: {
        type: User,
        resolve(event) {
          return models.User.findOne(event.creatorId)
        }
      },
      group: {
        type: Group,
        resolve(event) {
          return event.getGroup();
        }
      },
      slug: {
        type: GraphQLString,
        resolve(event) {
          return event.slug;
        }
      },
      locationString: {
        type: GraphQLString,
        resolve(event) {
          return event.locationString;
        }
      },
      startsAt: {
        type: GraphQLString,
        resolve(event) {
          return event.startsAt
        }
      },
      endsAt: {
        type: GraphQLString,
        resolve(event) {
          return event.startsAt
        }
      },
      maxAmount: {
        type: GraphQLInt,
        resolve(event) {
          return event.maxAmount;
        }
      },
      currency: {
        type: GraphQLString,
        resolve(event) {
          return event.currency;
        }
      },
      tiers: {
        type: new GraphQLList(Tier),
        resolve(event) {
          return event.getTiers();
        }
      },
      responses: {
        type: new GraphQLList(Response),
        resolve(tier) {
          return tier.getResponses();
        }
      }

    }
  }
});

const Tier = new GraphQLObjectType({
  name: 'Tier',
  description: 'This represents an Tier',
  fields: () => {
    return {
      id: {
        type: GraphQLInt,
        resolve(tier) {
          return tier.id;
        }
      },
      name: {
        type: GraphQLString,
        resolve(tier) {
          return tier.name
        }
      },
      description: {
        type: GraphQLString,
        resolve(tier) {
          return tier.description
        }
      },
      amount: {
        type: GraphQLInt,
        resolve(tier) {
          return tier.amount;
        }
      },
      currency: {
        type: GraphQLString,
        resolve(tier) {
          return tier.currency;
        }
      },
      quantity: {
        type: GraphQLInt,
        resolve(tier) {
          return tier.quantity;
        }
      },
      password: {
        type: GraphQLString,
        resolve(tier) {
          return tier.password
        }
      },
      startsAt: {
        type: GraphQLString,
        resolve(tier) {
          return tier.startsAt
        }
      },
      endsAt: {
        type: GraphQLString,
        resolve(tier) {
          return tier.startsAt
        }
      },
      event: {
        type: Event,
        resolve(tier) {
          return tier.getEvent();
        }
      },
      responses: {
        type: new GraphQLList(Response),
        resolve(tier) {
          return tier.getResponses();
        }
      }
    }
  }
});

const Response = new GraphQLObjectType({
  name: 'Response',
  description: 'This is a Response',
  fields: () => {
    return {
       id: {
        type: GraphQLInt,
        resolve(response) {
          return response.id;
        }
      },
      quantity: {
        type: GraphQLInt,
        resolve(response) {
          return response.quantity;
        }
      },
      user: {
        type: User,
        resolve(response) {
          return response.getUser();
        }
      },
      group: {
        type: Group,
        resolve(response) {
          return response.getGroup();
        }
      },
      tier: {
        type: Tier,
        resolve(response) {
          return response.getTier();
        }
      },
      event: {
        type: Event,
        resolve(response) {
          return response.getEvent();
        }
      },
      confirmedAt: {
        type: GraphQLString,
        resolve(response) {
          return response.confirmedAt;
        }
      },
      status: {
        type: GraphQLString,
        resolve(response) {
          return response.status;
        }
      }
    }
  }
});


const Query = new GraphQLObjectType({
  name: 'Events',
  description: 'This is a root query',
  fields: () => {
    return {
      events: {
        type: new GraphQLList(Event),
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
  }
});

const Schema = new GraphQLSchema({
  query: Query
});

export default Schema