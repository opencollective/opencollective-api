import accountMutations from './AccountMutations';
import { addFundsMutation } from './AddFundsMutations';
import commentMutations from './CommentMutations';
import commentReactionMutations from './CommentReactionMutations';
import connectedAccountMutations from './ConnectedAccountMutations';
import conversationMutations from './ConversationMutations';
import createCollectiveMutation from './CreateCollectiveMutation';
import createFundMutation from './CreateFundMutation';
import createOrganizationMutation from './CreateOrganizationMutation';
import createProjectMutation from './CreateProjectMutation';
import expenseMutations from './ExpenseMutations';
import guestMutations from './GuestMutations';
import hostApplicationMutations from './HostApplicationMutations';
import memberMutations from './MemberMutations';
import orderMutations from './OrderMutations';
import paymentMethodMutations from './PaymentMethodMutations';
import payoutMethodMutations from './PayoutMethodMutations';
import transactionMutations from './TransactionMutations';
import updateMutations from './UpdateMutations';

const mutation = {
  addFunds: addFundsMutation,
  createCollective: createCollectiveMutation,
  createFund: createFundMutation,
  createOrganization: createOrganizationMutation,
  createProject: createProjectMutation,
  ...commentMutations,
  ...commentReactionMutations,
  ...connectedAccountMutations,
  ...conversationMutations,
  ...expenseMutations,
  ...hostApplicationMutations,
  ...accountMutations,
  ...guestMutations,
  ...payoutMethodMutations,
  ...orderMutations,
  ...paymentMethodMutations,
  ...transactionMutations,
  ...memberMutations,
  ...updateMutations,
};

export default mutation;
