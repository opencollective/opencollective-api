import commentMutations from './CommentMutations';
import connectedAccountMutations from './ConnectedAccountMutations';
import conversationMutations from './ConversationMutations';
import createCollectiveMutations from './CreateCollectiveMutations';
import expenseMutations from './ExpenseMutations';
import accountMutations from './AccountMutations';
import collectiveMutations from './CollectiveMutations';

const mutation = {
  ...commentMutations,
  ...connectedAccountMutations,
  ...conversationMutations,
  ...createCollectiveMutations,
  ...expenseMutations,
  ...accountMutations,
  ...collectiveMutations,
};

export default mutation;
