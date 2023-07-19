import { expect } from 'chai';

import models from '../../../server/models/index.js';
import { fakeComment, fakeUser } from '../../test-helpers/fake-data.js';

describe('test/server/models/Expense', () => {
  describe('Create', () => {
    it('Must be a valid emoji', async () => {
      const invalidEmojiError = 'Must be in 👍️,👎,😀,🎉,😕,❤️,🚀,👀';
      const user = await fakeUser();
      const comment = await fakeComment();
      await expect(models.EmojiReaction.addReactionOnComment(user, comment.id, '')).to.be.rejectedWith(
        invalidEmojiError,
      );
      await expect(models.EmojiReaction.addReactionOnComment(user, comment.id, 'X')).to.be.rejectedWith(
        invalidEmojiError,
      );
      await expect(models.EmojiReaction.addReactionOnComment(user, comment.id, '🥔️')).to.be.rejectedWith(
        invalidEmojiError,
      );
      const reaction = await models.EmojiReaction.addReactionOnComment(user, comment.id, '👍️');
      expect(reaction.emoji).to.eq('👍️');
      expect(reaction.FromCollectiveId).to.eq(user.CollectiveId);
    });
  });
});
