import accountMutations from './AccountMutations';
import { addFundsMutation } from './AddFundsMutations';
import commentMutations from './CommentMutations';
import connectedAccountMutations from './ConnectedAccountMutations';
import conversationMutations from './ConversationMutations';
import createCollectiveMutation from './CreateCollectiveMutation';
import createEventMutation from './CreateEventMutation';
import createFundMutation from './CreateFundMutation';
import createOrganizationMutation from './CreateOrganizationMutation';
import createProjectMutation from './CreateProjectMutation';
import emojiReactionMutations from './EmojiReactionMutations';
import expenseMutations from './ExpenseMutations';
import guestMutations from './GuestMutations';
import hostApplicationMutations from './HostApplicationMutations';
import individualMutations from './IndividualMutations';
import memberInvitationMutations from './MemberInvitationMutations';
import memberMutations from './MemberMutations';
import orderMutations from './OrderMutations';
import paymentMethodMutations from './PaymentMethodMutations';
import payoutMethodMutations from './PayoutMethodMutations';
import transactionMutations from './TransactionMutations';
import updateMutations from './UpdateMutations';
import virtualCardMutations from './VirtualCardMutations';

const mutation = {
  addFunds: addFundsMutation,
  createCollective: createCollectiveMutation,
  createFund: createFundMutation,
  createOrganization: createOrganizationMutation,
  createProject: createProjectMutation,
  createEvent: createEventMutation,
  ...commentMutations,
  ...connectedAccountMutations,
  ...conversationMutations,
  ...expenseMutations,
  ...emojiReactionMutations,
  ...hostApplicationMutations,
  ...accountMutations,
  ...guestMutations,
  ...payoutMethodMutations,
  ...orderMutations,
  ...paymentMethodMutations,
  ...transactionMutations,
  ...memberMutations,
  ...memberInvitationMutations,
  ...updateMutations,
  ...individualMutations,
  ...virtualCardMutations,
};

export default mutation;
