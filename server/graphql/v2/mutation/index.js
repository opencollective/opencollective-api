import accountMutations from './AccountMutations';
import commentMutations from './CommentMutations';
import connectedAccountMutations from './ConnectedAccountMutations';
import conversationMutations from './ConversationMutations';
import createCollectiveMutations from './CreateCollectiveMutations';
import expenseMutations from './ExpenseMutations';

const mutation = {
  ...commentMutations,
  ...connectedAccountMutations,
  ...conversationMutations,
  ...createCollectiveMutations,
  ...expenseMutations,
  ...accountMutations,
};

export default mutation;
