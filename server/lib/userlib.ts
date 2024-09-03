export default {
  /*
   * Extract username from github image url
   * Needed to get usernames for github signups
   */
  getUsernameFromGithubURL(url) {
    try {
      const parsedUrl = new URL(url);
      if (parsedUrl.hostname === 'avatars.githubusercontent.com') {
        const regex = /\/([^/]+)/;
        const match = parsedUrl.pathname.match(regex);
        if (match) {
          return match[1];
        }
      }
    } catch {
      return null; // Ignore parsing errors
    }

    return null;
  },
};
