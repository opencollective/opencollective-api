import { expect } from 'chai';

import type { ReactionEmoji } from '../../../server/constants/reaction-emoji';
import models from '../../../server/models';
import { fakeComment, fakeUser } from '../../test-helpers/fake-data';

/** These tests cover the validation of user-provided emojis. */
const userProvidedEmoji = (emoji: string) => emoji as ReactionEmoji;

describe('test/server/models/Expense', () => {
  describe('Create', () => {
    it('Must be a valid emoji', async () => {
      const invalidEmojiError = 'Must be in 👍️,👎,😀,🎉,😕,❤️,🚀,👀';
      const user = await fakeUser();
      const comment = await fakeComment();
      await expect(
        models.EmojiReaction.addReactionOnComment(user, comment.id, userProvidedEmoji('')),
      ).to.be.rejectedWith(invalidEmojiError);
      await expect(
        models.EmojiReaction.addReactionOnComment(user, comment.id, userProvidedEmoji('X')),
      ).to.be.rejectedWith(invalidEmojiError);
      await expect(
        models.EmojiReaction.addReactionOnComment(user, comment.id, userProvidedEmoji('🥔️')),
      ).to.be.rejectedWith(invalidEmojiError);
      const reaction = await models.EmojiReaction.addReactionOnComment(user, comment.id, '👍️');
      expect(reaction.emoji).to.eq('👍️');
      expect(reaction.FromCollectiveId).to.eq(user.CollectiveId);
    });
  });
});
