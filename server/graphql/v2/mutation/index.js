import accountMutations from './AccountMutations';
import collectiveMutations from './CollectiveMutations';
import commentMutations from './CommentMutations';
import commentReactionMutations from './CommentReactionMutations';
import connectedAccountMutations from './ConnectedAccountMutations';
import conversationMutations from './ConversationMutations';
import createCollectiveMutation from './CreateCollectiveMutation';
import expenseMutations from './ExpenseMutations';
import orderMutations from './OrderMutations';
import paymentMethodMutations from './PaymentMethodMutations';
import payoutMethodMutations from './PayoutMethodMutations';

const mutation = {
  createCollective: createCollectiveMutation,
  ...commentMutations,
  ...commentReactionMutations,
  ...connectedAccountMutations,
  ...conversationMutations,
  ...expenseMutations,
  ...accountMutations,
  ...collectiveMutations,
  ...payoutMethodMutations,
  ...orderMutations,
  ...paymentMethodMutations,
};

export default mutation;
