// Mattermost is compatible with Slack webhooks
const KNOWN_MATTERMOST_INSTANCES = ['https://chat.diglife.coop/hooks/'];
const SLACK_WEBHOOK_HOSTNAME = 'hooks.slack.com';
const DISCORD_WEBHOOK_HOSTNAMES = new Set(['discord.com', 'discordapp.com']);
const DISCORD_WEBHOOK_PATH_PREFIX = '/api/webhooks/';

const parseHttpsWebhookUrl = (url: string): URL | null => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? parsed : null;
  } catch {
    return null;
  }
};

const isSlackHooksWebhookUrl = (url: string): boolean => {
  const parsed = parseHttpsWebhookUrl(url);
  return parsed?.hostname === SLACK_WEBHOOK_HOSTNAME;
};

const isDiscordWebhookUrl = (url: string): boolean => {
  const parsed = parseHttpsWebhookUrl(url);
  if (!parsed || !DISCORD_WEBHOOK_HOSTNAMES.has(parsed.hostname)) {
    return false;
  }

  const pathAfterPrefix = parsed.pathname.slice(DISCORD_WEBHOOK_PATH_PREFIX.length);
  return parsed.pathname.startsWith(DISCORD_WEBHOOK_PATH_PREFIX) && pathAfterPrefix.length > 0;
};

const isKnownMattermostWebhookUrl = (url: string): boolean => {
  const parsed = parseHttpsWebhookUrl(url);
  if (!parsed) {
    return false;
  }

  return KNOWN_MATTERMOST_INSTANCES.some(instanceUrl => {
    const instance = new URL(instanceUrl);
    return parsed.hostname === instance.hostname && parsed.pathname.startsWith(instance.pathname);
  });
};

export const isTrustedWebhookProviderUrl = (url: string): boolean => {
  return isSlackHooksWebhookUrl(url) || isDiscordWebhookUrl(url) || isKnownMattermostWebhookUrl(url);
};

export const toDiscordSlackCompatibleWebhookUrl = (url: string): string => {
  if (!isDiscordWebhookUrl(url)) {
    return url;
  }

  const parsed = new URL(url);
  const normalizedPath = parsed.pathname.replace(/\/+$/, '');
  if (normalizedPath.endsWith('/slack')) {
    return url;
  }

  // Discord slack-compatible webhook - See https://discord.com/developers/docs/resources/webhook#execute-slackcompatible-webhook
  parsed.pathname = `${normalizedPath}/slack`;
  return parsed.toString();
};
