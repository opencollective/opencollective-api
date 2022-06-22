import { GraphQLNonNull } from 'graphql';
import slugify from 'limax';
import { pick } from 'lodash';
import { v4 as uuid } from 'uuid';

import roles from '../../../constants/roles';
import { isCollectiveSlugReserved } from '../../../lib/collectivelib';
import models from '../../../models';
import { NotFound, Unauthorized } from '../../errors';
import { AccountReferenceInput, fetchAccountWithReference } from '../input/AccountReferenceInput';
import { EventCreateInput } from '../input/EventCreateInput';
import { Event } from '../object/Event';

const DEFAULT_EVENT_SETTINGS = {};

async function createEvent(_, args, req) {
  const { remoteUser } = req;

  if (!remoteUser) {
    throw new Unauthorized('You need to be logged in to create an Event');
  }

  const parent = await fetchAccountWithReference(args.account);
  if (!parent) {
    throw new NotFound('Parent not found');
  }
  if (!req.remoteUser.hasRole([roles.ADMIN, roles.MEMBER], parent.id)) {
    throw new Unauthorized(`You must be logged in as a member of the ${parent.slug} collective to create an Event`);
  }

  const eventData = {
    type: 'EVENT',
    slug: `${slugify(args.event.slug || args.event.name)}-${uuid().substr(0, 8)}`,
    ...pick(args.event, ['name', 'description']),
    ...pick(parent.info, ['currency', 'HostCollectiveId', 'isActive', 'platformFeePercent', 'hostFeePercent']),
    approvedAt: parent.isActive ? new Date() : null,
    startsAt: args.event.startsAt,
    endsAt: args.event.endsAt,
    timezone: args.event.timezone,
    ParentCollectiveId: parent.id,
    CreatedByUserId: remoteUser.id,
    settings: { ...DEFAULT_EVENT_SETTINGS, ...args.event.settings },
  };

  if (isCollectiveSlugReserved(eventData.slug)) {
    throw new Error(`The slug '${eventData.slug}' is not allowed.`);
  }
  const checkSlug = await models.Collective.findOne({ where: { slug: eventData.slug } });
  if (checkSlug) {
    throw new Error(`The slug '${eventData.slug}' is already taken. Please use another slug for the Event.`);
  }

  return models.Collective.create(eventData);
}

const createEventMutation = {
  type: Event,
  args: {
    event: {
      description: 'Information about the Event to create (name, slug, description, tags, settings)',
      type: new GraphQLNonNull(EventCreateInput),
    },
    account: {
      description: 'Reference to the parent Account creating the Event.',
      type: new GraphQLNonNull(AccountReferenceInput),
    },
  },
  resolve: (_, args, req) => {
    return createEvent(_, args, req);
  },
};

export default createEventMutation;
