import config from 'config';
import { clamp } from 'lodash';

import slackLib from '../lib/slack';

/** Return type when running a spam analysis */
export type SpamAnalysisReport = {
  /** When did the report occur */
  date: string;
  /** What's the context of the report */
  context: string;
  /** Data of the entity that was analyzed */
  data: object;
  /** A score between 0 and 1. 0=NotSpam, 1=IsSpamForSure */
  score: number;
  /** Detected spam keywords */
  keywords: string[];
  /** Detected blacklisted domains */
  domains: string[];
};

// Watched content
const ANALYZED_FIELDS: string[] = ['name', 'website', 'description', 'longDescription'];

// A map of spam keywords<>score. Please keep everything in there lowercase.
const SPAM_KEYWORDS: { [keyword: string]: number } = {
  keto: 0.3,
  porn: 0.2,
  pills: 0.1,
  'male enhancement': 0.3,
};

// Any domain from there gives you a SPAM scrore of 1
const SPAMMERS_DOMAINS = [
  'advisoroffer.com',
  'afterhourshealth.com',
  'alertpills.com',
  'allsupplementshop.com',
  'amazonhealthmart.com',
  'atozfitnesstalks.com',
  'avengersdiet.com',
  'biznutrition.com',
  'bumpsweat.com',
  'buypurelifeketo.com',
  'cerld.com',
  'completefoods.co',
  'creativehealthcart.com',
  'dailydealsreview.info',
  'dasilex.co.uk',
  'demandsupplement.com',
  'diets2try.com',
  'dragonsdenketo.com',
  'faqssupplement.com',
  'fitcareketo.com',
  'fitdiettrends.com',
  'fitnesscarezone.com',
  'fitnessdietreviews.com',
  'fitnessmegamart.com',
  'fitnessprocentre.com',
  'fitpedia.org',
  'health4trend.com',
  'healthsupplementcart.com',
  'healthtalkrev.com',
  'healthyaustralia.com.au',
  'healthycliq.com',
  'healthygossips.com',
  'healthyslimdiet.com',
  'healthytalkz.com',
  'herbalsupplementreview.com',
  'herbalweightlossreview.com',
  'hulkdiet.com',
  'hulkpills.com',
  'hulksupplement.com',
  'hyalurolift.fr',
  'identifyscam.com',
  'insta-keto.org',
  'issuu.com',
  'keto-bodytone.com',
  'keto-top.org',
  'keto-ultra-diet.com',
  'ketoboostx.com',
  'ketodietfitness.com',
  'ketodietsplan.com',
  'ketodietstores.com',
  'ketodietwalmart.com',
  'ketofitstore.com',
  'ketogenicdietpills.com',
  'ketohour.com',
  'ketopiller.com',
  'ketoplanusa.com',
  'ketopure-org.over-blog.com',
  'ketopure.org',
  'ketopurediets.com',
  'ketoreviews.co.uk',
  'ketotop-diet.com',
  'ketotrin.info',
  'ketovatrudiet.info',
  'ketoviante.info',
  'maleenhancementtips.com',
  'marketwatch.com',
  'menhealthdiets.com',
  'myfitnesspharm.com',
  'myshorturl.net',
  'naturalketopill.com',
  'nutraplatform.com',
  'nutrifitweb.com',
  'offer4cart.com',
  'onnitsupplements.com',
  'orderfitness.org',
  'organicsupplementdietprogram.com',
  'petsaw.com',
  'pharmacistreviews.com',
  'pillsfect.com',
  'pilsadiet.com',
  'pornlike.net',
  'praltrix.info',
  'purefitketopills.com',
  'reviewmypills.com',
  'reviewsbox.org',
  'reviewsbox360.wixsite.com',
  'reviewscart.co.uk',
  'riteketopills.com',
  'sharktankdiets.com',
  'steroidscience.org',
  'supplement4muscle.com',
  'supplementblend.com',
  'supplementdose.com',
  'supplementgear.com',
  'supplementgo.com',
  'supplementrise.com',
  'supplementscare.co.za',
  'supplementslove.com',
  'supplementspeak.com',
  'takeapills.com',
  'thebackplane.com',
  'thehealthwind.com',
  'thenutritionvibe.com',
  'time2trends.com',
  'timeofhealth.org',
  'topcbdoilhub.com',
  'totaldiet4you.com',
  'totalketopills.com',
  'trippleresult.com',
  'trypurenutrition.com',
  'uchearts.com',
  'usahealthpills.com',
  'webcampornodirecto.es',
  'wellnessketoz.com',
  'wheretocare.com',
  'worldgymdiet.com',
];

/**
 * Returns suspicious keywords found in content
 */
export const getSuspiciousKeywords = (content: string): string[] => {
  if (!content) {
    return [];
  }

  return Object.keys(SPAM_KEYWORDS).reduce((result, keyword) => {
    if (content.toLowerCase().includes(keyword)) {
      result.push(keyword);
    }

    return result;
  }, []);
};

/**
 *
 * Returns blacklisted domains found in content
 */
const getSpamDomains = (content: string): string[] => {
  if (!content) {
    return [];
  }

  return SPAMMERS_DOMAINS.reduce((result, domain) => {
    if (content.toLowerCase().includes(domain)) {
      result.push(domain);
    }
    return result;
  }, []);
};

/**
 * Checks the values for this collective to try to determinate if it's a spammy profile.
 */
export const collectiveSpamCheck = (collective: any, context: string): SpamAnalysisReport => {
  const result = { score: 0, keywords: new Set<string>(), domains: new Set<string>() };

  ANALYZED_FIELDS.forEach(field => {
    // Check each field for SPAM keywords
    const suspiciousKeywords = getSuspiciousKeywords(collective[field] || '');
    suspiciousKeywords.forEach(keyword => {
      result.keywords.add(keyword);
      result.score += SPAM_KEYWORDS[keyword];
    });

    // Check for blacklisted domains
    const blacklitedDomains = getSpamDomains(collective[field] || '');
    if (blacklitedDomains.length) {
      blacklitedDomains.forEach(domain => result.domains.add(domain));
      result.score = 1;
    }
  });

  return {
    date: new Date().toISOString(),
    score: clamp(result.score, 0, 1),
    keywords: Array.from(result.keywords),
    domains: Array.from(result.domains),
    data: collective.info || collective,
    context,
  };
};

/**
 * Post a message on Slack if the collective is suspicious
 */
export const notifyTeamAboutSuspiciousCollective = async (report: SpamAnalysisReport): Promise<void> => {
  const { score, keywords, domains, data } = report;
  let message = `*Suspicious collective data was submitted for collective:* https://opencollective.com/${data['slug']}`;
  const addLine = (line: string): string => (line ? `${message}\n${line}` : message);
  message = addLine(`Score: ${score}`);
  message = addLine(keywords.length > 0 && `Keywords: \`${keywords.toString()}\``);
  message = addLine(domains.length > 0 && `Domains: \`${domains.toString()}\``);
  return slackLib.postMessage(message, config.slack.webhookUrl, {
    channel: config.slack.abuseChannel,
  });
};

/**
 * Post a message on Slack if the collective is suspicious
 */
export const notifyTeamAboutPreventedCollectiveCreate = async (
  report: SpamAnalysisReport,
  user: any | null,
): Promise<void> => {
  const { keywords, domains } = report;
  let message = `A collective creation was prevented and the user has been put in limited mode.`;
  const addLine = (line: string): string => (line ? `${message}\n${line}` : message);
  if (user) {
    message = addLine(`UserId: ${user.id}`);
  }
  message = addLine(keywords.length > 0 && `Keywords: \`${keywords.toString()}\``);
  message = addLine(domains.length > 0 && `Domains: \`${domains.toString()}\``);
  message = addLine(`Collective data:`);
  message = addLine(`> ${JSON.stringify(report.data)}`);
  return slackLib.postMessage(message, config.slack.webhookUrl, {
    channel: config.slack.abuseChannel,
  });
};
