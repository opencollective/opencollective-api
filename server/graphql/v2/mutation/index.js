import accountMutations from './AccountMutations';
import { addFundsMutation } from './AddFundsMutations';
import applicationMutations from './ApplicationMutations';
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
import oauthAuthorizationMutations from './OAuthAuthorizationMutations';
import orderMutations from './OrderMutations';
import paymentMethodMutations from './PaymentMethodMutations';
import payoutMethodMutations from './PayoutMethodMutations';
import rootMutations from './RootMutations';
import transactionMutations from './TransactionMutations';
import updateMutations from './UpdateMutations';
import virtualCardMutations from './VirtualCardMutations';

const mutation = {
  addFunds: addFundsMutation,
  createCollective: createCollectiveMutation,
  createEvent: createEventMutation,
  createFund: createFundMutation,
  createOrganization: createOrganizationMutation,
  createProject: createProjectMutation,
  ...accountMutations,
  ...applicationMutations,
  ...commentMutations,
  ...connectedAccountMutations,
  ...conversationMutations,
  ...emojiReactionMutations,
  ...expenseMutations,
  ...guestMutations,
  ...hostApplicationMutations,
  ...individualMutations,
  ...memberInvitationMutations,
  ...memberMutations,
  ...oauthAuthorizationMutations,
  ...orderMutations,
  ...paymentMethodMutations,
  ...payoutMethodMutations,
  ...rootMutations,
  ...transactionMutations,
  ...updateMutations,
  ...virtualCardMutations,
};

export default mutation;
