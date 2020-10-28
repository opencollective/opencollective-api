import accountMutations from './AccountMutations';
import { addFundsMutation } from './AddFundsMutations';
import collectiveMutations from './CollectiveMutations';
import commentMutations from './CommentMutations';
import commentReactionMutations from './CommentReactionMutations';
import connectedAccountMutations from './ConnectedAccountMutations';
import conversationMutations from './ConversationMutations';
import createCollectiveMutation from './CreateCollectiveMutation';
import createFundMutation from './CreateFundMutation';
import createProjectMutation from './CreateProjectMutation';
import expenseMutations from './ExpenseMutations';
import guestMutations from './GuestMutations';
import memberMutations from './MemberMutations';
import orderMutations from './OrderMutations';
import paymentMethodMutations from './PaymentMethodMutations';
import payoutMethodMutations from './PayoutMethodMutations';
import transactionMutations from './TransactionMutations';

const mutation = {
  addFunds: addFundsMutation,
  createCollective: createCollectiveMutation,
  createFund: createFundMutation,
  createProject: createProjectMutation,
  ...commentMutations,
  ...commentReactionMutations,
  ...connectedAccountMutations,
  ...conversationMutations,
  ...expenseMutations,
  ...accountMutations,
  ...collectiveMutations,
  ...guestMutations,
  ...payoutMethodMutations,
  ...orderMutations,
  ...paymentMethodMutations,
  ...transactionMutations,
  ...memberMutations,
};

export default mutation;
