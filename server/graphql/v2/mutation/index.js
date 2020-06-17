import accountMutations from './AccountMutations';
import collectiveMutations from './CollectiveMutations';
import commentMutations from './CommentMutations';
import commentReactionMutations from './CommentReactionMutations';
import connectedAccountMutations from './ConnectedAccountMutations';
import conversationMutations from './ConversationMutations';
import createCollectiveMutations from './CreateCollectiveMutations';
import expenseMutations from './ExpenseMutations';
import orderMutations from './OrderMutations';
import paymentMethodMutations from './PaymentMethodMutations';
import payoutMethodMutations from './PayoutMethodMutations';

const mutation = {
  ...commentMutations,
  ...commentReactionMutations,
  ...connectedAccountMutations,
  ...conversationMutations,
  ...createCollectiveMutations,
  ...expenseMutations,
  ...accountMutations,
  ...collectiveMutations,
  ...payoutMethodMutations,
  ...orderMutations,
  ...paymentMethodMutations,
};

export default mutation;
