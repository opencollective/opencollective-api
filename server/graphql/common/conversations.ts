import { Request } from 'express';
import { pick } from 'lodash-es';

import FEATURE from '../../constants/feature.js';
import { hasFeature } from '../../lib/allowed-features.js';
import models from '../../models/index.js';
import Conversation from '../../models/Conversation.js';
import { FeatureNotSupportedForCollective, NotFound, Unauthorized } from '../errors.js';

import { checkRemoteUserCanUseConversations } from './scope-check.js';

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
  const collective = await req.loaders.Collective.byId.load(CollectiveId);
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
