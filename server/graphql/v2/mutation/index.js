import accountMutations from './AccountMutations';
import collectiveMutations from './CollectiveMutations';
import commentMutations from './CommentMutations';
import connectedAccountMutations from './ConnectedAccountMutations';
import conversationMutations from './ConversationMutations';
import createCollectiveMutations from './CreateCollectiveMutations';
import expenseMutations from './ExpenseMutations';
import orderMutations from './OrderMutations';
import payoutMethodMutations from './PayoutMethodMutations';

const mutation = {
  ...commentMutations,
  ...connectedAccountMutations,
  ...conversationMutations,
  ...createCollectiveMutations,
  ...expenseMutations,
  ...accountMutations,
  ...collectiveMutations,
  ...payoutMethodMutations,
  ...orderMutations,
};

export default mutation;
