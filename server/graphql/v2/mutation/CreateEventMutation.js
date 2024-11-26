import { GraphQLNonNull } from 'graphql';
import slugify from 'limax';
import { pick } from 'lodash';
import { v4 as uuid } from 'uuid';

import roles from '../../../constants/roles';
import { canUseSlug } from '../../../lib/collectivelib';
import models from '../../../models';
import { checkRemoteUserCanUseAccount } from '../../common/scope-check';
import { BadRequest, NotFound, Unauthorized } from '../../errors';
import { handleCollectiveImageUploadFromArgs } from '../input/AccountCreateInputImageFields';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../input/AccountReferenceInput';
import { GraphQLEventCreateInput } from '../input/EventCreateInput';
import { GraphQLEvent } from '../object/Event';

const DEFAULT_EVENT_SETTINGS = {};

async function createEvent(_, args, req) {
  checkRemoteUserCanUseAccount(req);

  const parent = await fetchAccountWithReference(args.account);
  if (!parent) {
    throw new NotFound('Parent account not found');
  }
  if (parent.type === 'USER') {
    throw new BadRequest('Parent account should not be an Individual account');
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
    CreatedByUserId: req.remoteUser.id,
    settings: { ...DEFAULT_EVENT_SETTINGS, ...args.event.settings },
  };

  if (!canUseSlug(eventData.slug, req.remoteUser)) {
    throw new Error(`The slug '${eventData.slug}' is not allowed.`);
  }
  const checkSlug = await models.Collective.findOne({ where: { slug: eventData.slug } });
  if (checkSlug) {
    throw new Error(`The slug '${eventData.slug}' is already taken. Please use another slug for the Event.`);
  }

  // Validate now to avoid uploading images if the collective is invalid
  const event = models.Collective.build(eventData);
  await event.validate();

  // Attach images
  const { avatar, banner } = await handleCollectiveImageUploadFromArgs(req.remoteUser, args.event);
  event.image = avatar?.url ?? event.image;
  event.backgroundImage = banner?.url ?? event.backgroundImage;

  await event.save();
  event.generateCollectiveCreatedActivity(req.remoteUser, req.userToken);
  return event;
}

const createEventMutation = {
  type: GraphQLEvent,
  description: 'Create an Event. Scope: "account".',
  args: {
    event: {
      description: 'Information about the Event to create (name, slug, description, tags, settings)',
      type: new GraphQLNonNull(GraphQLEventCreateInput),
    },
    account: {
      description: 'Reference to the parent Account creating the Event.',
      type: new GraphQLNonNull(GraphQLAccountReferenceInput),
    },
  },
  resolve: (_, args, req) => {
    return createEvent(_, args, req);
  },
};

export default createEventMutation;
