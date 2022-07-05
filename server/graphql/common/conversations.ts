import { Request } from 'express';
import { pick } from 'lodash';

import FEATURE from '../../constants/feature';
import { hasFeature } from '../../lib/allowed-features';
import { canUseFeature } from '../../lib/user-permissions';
import models from '../../models';
import { FeatureNotAllowedForUser, FeatureNotSupportedForCollective, NotFound, Unauthorized } from '../errors';

/** Params given to create a new conversation */
interface CreateConversationParams {
  title: string;
  html: string;
  CollectiveId: number;
  tags?: string[] | null;
}

export const checkRemoteUserCanUseConversations = req => {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to manage conversations');
  }
  if (!canUseFeature(req.remoteUser, FEATURE.CONVERSATIONS)) {
    throw new FeatureNotAllowedForUser();
  }
  if (req.userToken && !req.userToken.getScope().includes('conversations')) {
    throw new Unauthorized('The User Token is not allowed for mutations in scope "conversations".');
  }
};

/**
 * Create a conversation started by the given `remoteUser`.
 *
 * @returns the conversation
 */
export const createConversation = async (
  req: Request,
  params: CreateConversationParams,
): Promise<typeof models.Conversation> => {
  // For now any authenticated user can create a conversation to any collective
  checkRemoteUserCanUseConversations(req);

  const { CollectiveId, title, html, tags } = params;

  // Collective must exist and be of type `COLLECTIVE`
  const collective = await models.Collective.findByPk(CollectiveId);
  if (!collective) {
    throw new Error("This Collective doesn't exist or has been deleted");
  } else if (!hasFeature(collective, FEATURE.CONVERSATIONS)) {
    throw new FeatureNotSupportedForCollective();
  }

  return models.Conversation.createWithComment(req.remoteUser, collective, title, html, tags);
};

interface EditConversationParams {
  id: number;
  title: string;
}

/**
 * Edit a conversation started by the given `remoteUser`.
 *
 * @returns the conversation
 */
export const editConversation = async (
  req: Request,
  params: EditConversationParams,
): Promise<typeof models.Conversation> => {
  checkRemoteUserCanUseConversations(req);

  // Collective must exist and use be author or collective admin
  const conversation = await models.Conversation.findByPk(params.id);
  if (!conversation) {
    throw new NotFound();
  } else if (
    !req.remoteUser.isAdmin(conversation.FromCollectiveId) &&
    !req.remoteUser.isAdmin(conversation.CollectiveId)
  ) {
    throw new Unauthorized();
  }

  return conversation.update(pick(params, ['title', 'tags']));
};
