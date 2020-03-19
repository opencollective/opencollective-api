import commentMutations from './CommentMutations';
import conversationMutations from './ConversationMutations';
import createCollectiveMutations from './CreateCollectiveMutations';
import expenseMutations from './ExpenseMutations';
import accountMutations from './AccountMutations';

const mutation = {
  ...commentMutations,
  ...conversationMutations,
  ...createCollectiveMutations,
  ...expenseMutations,
  ...accountMutations,
};

export default mutation;
