import { Request } from 'express';
import { pick } from 'lodash';

import FEATURE from '../../constants/feature';
import { hasFeature } from '../../lib/allowed-features';
import models from '../../models';
import Conversation from '../../models/Conversation';
import { FeatureNotSupportedForCollective, NotFound, Unauthorized } from '../errors';

import { checkRemoteUserCanUseConversations } from './scope-check';

/** Params given to create a new conversation */
interface CreateConversationParams {
  title: string;
  html: string;
  CollectiveId: number;
  tags?: string[] | null;
}

/**
 * Create a conversation started by the given `remoteUser`.
 *
 * @returns the conversation
 */
export const createConversation = async (req: Request, params: CreateConversationParams): Promise<Conversation> => {
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

  return Conversation.createWithComment(req.remoteUser, collective, title, html, tags);
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
export const editConversation = async (req: Request, params: EditConversationParams): Promise<Conversation> => {
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
