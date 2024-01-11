import config from 'config';

const cookieName = 'rootRedirectDashboard';

export const setRedirectCookie = res => {
  res.cookie(cookieName, 'true', {
    secure: true,
    httpOnly: true,
    sameSite: config.env === 'production' ? 'lax' : 'none',
    maxAge: 24 * 60 * 60 * 1000 * 365,
  });
};

export const clearRedirectCookie = res => {
  res.clearCookie(cookieName);
};
