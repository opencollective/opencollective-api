import commentMutations from './CommentMutations';
import conversationMutations from './ConversationMutations';
import createCollectiveMutations from './CreateCollectiveMutations';
import expenseMutations from './ExpenseMutations';
import membersMutations from './MembersMutations';

const mutation = {
  ...commentMutations,
  ...conversationMutations,
  ...createCollectiveMutations,
  ...expenseMutations,
  ...membersMutations,
};

export default mutation;
