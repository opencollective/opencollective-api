import emailLib from '../../lib/email';
import errors from '../../lib/errors';
import models from '../../models';

export const unsubscribe = async (req, res, next) => {
  const { type, email, slug, token } = req.params;

  if (!emailLib.isValidUnsubscribeToken(token, email, slug, type)) {
    return next(new errors.BadRequest('Invalid token'));
  }

  try {
    const collective = await models.Collective.findOne({ where: { slug } });
    const user = await models.User.findOne({ where: { email } });
    if (!user) {
      throw new errors.NotFound(`Cannot find a user with email "${email}"`);
    }

    await models.Notification.unsubscribe(type, 'email', user.id, collective?.id);
    res.send({ response: 'ok' });
  } catch (e) {
    next(e);
  }
};
