import fs from 'fs';
import path from 'path';

import bayes from 'bayes';
import { clamp } from 'lodash';

import slackLib, { OPEN_COLLECTIVE_SLACK_CHANNEL } from '../lib/slack';

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
  /** Detected blocked domains */
  domains: string[];
  /** Result of the Bayes check, spam or ham */
  bayes: string;
};

export type BayesClassifier = {
  /** Categorize a content string */
  categorize: Function;
};

// Watched content
const ANALYZED_FIELDS: string[] = ['name', 'website', 'description', 'longDescription'];

// A map of spam keywords<>score. Please keep everything in there lowercase.
const SPAM_KEYWORDS: { [keyword: string]: number } = {
  'anti aging': 0.3,
  'blood flow': 0.3,
  'car seats': 0.2,
  'fat burn': 0.3,
  'male enhancement': 0.3,
  'male health': 0.3,
  'real estate': 0.2,
  'weight loss': 0.3,
  canzana: 0.3,
  casino: 0.2,
  cbd: 0.3,
  ciagra: 0.3,
  cream: 0.1,
  credit: 0.2,
  escort: 0.3,
  forex: 0.2,
  gummies: 0.2,
  keto: 0.3,
  loan: 0.2,
  maleenhancement: 0.3,
  malehealth: 0.3,
  model: 0.1,
  mortgage: 0.2,
  muscle: 0.1,
  natural: 0.1,
  oil: 0.1,
  pharmacy: 0.1,
  pills: 0.2,
  poker: 0.2,
  porn: 0.2,
  review: 0.1,
  serum: 0.2,
  skin: 0.1,
  testosterone: 0.3,
  truvalast: 0.3,
  writer: 0.2,
};

// Any domain from there gives you a SPAM scrore of 1
export const SPAMMERS_DOMAINS = [
  'abellarora.com',
  'advisoroffer.com',
  'afterhourshealth.com',
  'airtravelmart.com',
  'alertpills.com',
  'allnutritionhub.com',
  'allsupplementshop.com',
  'amazonhealthmart.com',
  'anyflip.com',
  'apnews.com',
  'atozfitnesstalks.com',
  'avengersdiet.com',
  'bebee.com',
  'benzinga.com',
  'bhitmagazine.com.ng',
  'biznutra.com',
  'biznutrition.com',
  'bollyshake.com',
  'bonfire.com',
  'bumpsweat.com',
  'buypurelifeketo.com',
  'buzrush.com',
  'callgirlsindelhi.co.in',
  'canvas.elsevier.com',
  'canvas.msstate.edu',
  'canvas.pbsteacherline.org',
  'cerld.com',
  'clinicabalu.com',
  'completefoods.co',
  'consultbestastro.com',
  'copymethat.com',
  'coub.com',
  'create.arduino.cc',
  'creativehealthcart.com',
  'csopartnership.org',
  'cutt.us',
  'dailydealsreview.info',
  'dasilex.co.uk',
  'demandsupplement.com',
  'dietarypillsstore.com',
  'dietdoctor.com',
  'diets2try.com',
  'digitalvisi.com',
  'djpod.com',
  'dragonsdenketo.com',
  'dridainfotech.com',
  'edu-24.info',
  'elitecaretreatment.com',
  'faqssupplement.com',
  'feedsfloor.com',
  'fitcareketo.com',
  'fitdiettrends.com',
  'fitnesscarezone.com',
  'fitnessdietreviews.com',
  'fitnessmegamart.com',
  'fitnessprocentre.com',
  'fitpedia.org',
  'getyouroffers.xyz',
  'givebutter.com',
  'health4trend.com',
  'healthcarthub.com',
  'healthline.com',
  'healthlinenutrition.com',
  'healthmassive.com',
  'healthmife.com',
  'healthonlinecare.com',
  'healthsupplementcart.com',
  'healthtalkrev.blogspot.com',
  'healthtalkrev.com',
  'healthtalkrevfacts.blogspot.com',
  'healthverbs.com',
  'healthyaustralia.com.au',
  'healthycliq.com',
  'healthygossips.com',
  'healthymenuforchildren.blogspot.com',
  'healthyslimdiet.com',
  'healthytalkz.com',
  'hearthis.at',
  'herbalsupplementreview.com',
  'herbalweightlossreview.com',
  'hulkdiet.com',
  'hulkpills.com',
  'hulksupplement.com',
  'hyalurolift.fr',
  'identifyscam.com',
  'innovationdiet.com',
  'insta-keto.org',
  'ipsnews.net',
  'isajain.com',
  'janvhikapoor.com',
  'justgiving.com',
  'keto-bodytone.com',
  'keto-top.org',
  'keto-ultra-diet.com',
  'ketoboostx.com',
  'ketodietfitness.com',
  'ketodietsplan.com',
  'ketodietstores.com',
  'ketodietwalmart.com',
  'ketofasttrim.com',
  'ketofitstore.com',
  'ketogenicdietpills.com',
  'ketogenicsupplementsreview.com',
  'ketohour.com',
  'ketopiller.com',
  'ketoplanusa.com',
  'ketopremiere.info',
  'ketopure-org.over-blog.com',
  'ketopure.org',
  'ketopurediets.com',
  'ketoreviews.co.uk',
  'ketotop-diet.com',
  'ketotrin.info',
  'ketovatrudiet.info',
  'ketoviante.info',
  'ktc.instructure.com',
  'lakubet.co',
  'lunaireketobhb.blogspot.com',
  'mafiatek.my.id',
  'maleenhancementtips.com',
  'mariamd.com',
  'marketwatch.com',
  'medixocentre.com',
  'medlineplus.gov',
  'menhealthdiets.com',
  'merchantcircle.com',
  'minimore.com',
  'morioh.com',
  'mrxmaleenhancement-point.blogspot.com',
  'muckrack.com',
  'myfitnesspharm.com',
  'myshorturl.net',
  'myunbiasedreview.wordpress.com',
  'naturalketopill.com',
  'netchorus.com',
  'norton.com',
  'nutraplatform.com',
  'nutrifitweb.com',
  'nutritioun.com',
  'offer4cart.com',
  'office.com',
  'officemaster.ae',
  'onlineairlinesbooking.com',
  'onlinereservationbooking.com',
  'onnitsupplements.com',
  'orderfitness.org',
  'organicsupplementdietprogram.com',
  'ourunbiasedreview.blogspot.com',
  'paper.li',
  'patch.com',
  'penzu.com',
  'petsaw.com',
  'pharmacistreviews.com',
  'pillsfact.com',
  'pillsfect.com',
  'pillsmumy.com',
  'pillsvibe.com',
  'pilsadiet.com',
  'plarium.com',
  'pornlike.net',
  'praltrix.info',
  'products99.com',
  'pubhtml5.com',
  'publons.com',
  'purefiter.com',
  'purefitketopills.com',
  'purnimasingh.com',
  'rembachduong.vn',
  'reviewmypills.com',
  'reviewsbox.org',
  'reviewsbox360.wixsite.com',
  'reviewscart.co.uk',
  'riteketopills.com',
  'saatchiart.com',
  'saturdaysale.com',
  'sharktankdiets.com',
  'shwetabasu.com',
  'shwetachopra.com',
  'situsslots.net',
  'skatafka.com',
  'slimketopills.com',
  'smore.com',
  'soo.gd',
  'spa-india.azurewebsites.net',
  'spreaker.com',
  'staycure.com',
  'steroidscience.org',
  'streetinsider.com',
  'sunnyspotrealty.net',
  'supplement4muscle.com',
  'supplementarmy.com',
  'supplementblend.com',
  'supplementdose.com',
  'supplementgear.com',
  'supplementgo.com',
  'supplementrise.com',
  'supplementscare.co.za',
  'supplementslove.com',
  'supplementspeak.com',
  'surveensaniya.com',
  'switch-bot.com',
  'takeapills.com',
  'tans.ca',
  'tanyagupta.in',
  'teletype.in',
  'termpapersite.com',
  'thebackplane.com',
  'thefitnesssupplement.com',
  'thefitnesssupplementshop.blogspot.com',
  'thehealthwind.com',
  'thenutritionvibe.com',
  'thietkevanan.com',
  'time2trends.com',
  'timeofhealth.info',
  'timeofhealth.org',
  'timesofnews24x7.com',
  'tocal.instructure.com',
  'topcbdoilhub.com',
  'topusatrendpills.com',
  'totaldiet4you.com',
  'totalketopills.com',
  'trentandallievan.com',
  'tripoto.com',
  'trippleresult.com',
  'tryittoday.xyz',
  'trypurenutrition.com',
  'uchearts.com',
  'udaipurqueen.com',
  'usahealthpills.com',
  'videa.hu',
  'webcampornodirecto.es',
  'weddingwire.us',
  'wellnessketoz.com',
  'wfmj.com',
  'wheretocare.com',
  'wintersupplement.com',
  'wiseintro.co',
  'works.bepress.com',
  'worldgymdiet.com',
  'wow-keto.com',
  'zobuz.com',
];

export const NON_SPAMMERS_DOMAINS = [
  'about.me',
  'behance.net',
  'bit.do',
  'bit.ly',
  'crunchbase.com',
  'dailymotion.com',
  'dev.to',
  'docs.google.com',
  'dribbble.com',
  'emailmeform.com',
  'en.wikipedia.org',
  'facebook.com',
  'fda.gov',
  'form.jotform.com',
  'github.com',
  'gmail.com',
  'google.com',
  'gumroad.com',
  'i.imgur.com',
  'img.over-blog-kiwi.com',
  'instagram.com',
  'issuu.com',
  'k12.instructure.com',
  'linkedin.com',
  'linktr.ee',
  'marketwatch.com',
  'medium.com',
  'mndepted.instructure.com',
  'myspace.com',
  'ncbi.nlm.nih.gov',
  'opencollective-production.s3.us-west-1.amazonaws.com',
  'opencollective.com',
  'pinterest.com',
  'quora.com',
  'rb.gy',
  'reddit.com',
  's3.amazonaws.com',
  'scoop.it',
  'service.elsevier.com',
  'sites.google.com',
  'soundcloud.com',
  'surveymonkey.com',
  'teespring.com',
  'twitter.com',
  'utah.instructure.com',
  'wattpad.com',
  'youtu.be',
  'youtube.com',
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
 * Returns blocked domains found in content
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

let bayesClassifier;

const getBayesClassifier = async (): Promise<BayesClassifier> => {
  if (!bayesClassifier) {
    const bayesClassifierPath = path.join(__dirname, '..', '..', 'config', `collective-spam-bayes.json`);
    const bayesClassifierJson = await fs.promises.readFile(bayesClassifierPath, 'utf-8');
    bayesClassifier = bayes.fromJson(bayesClassifierJson);
  }
  return bayesClassifier;
};

export const collectiveBayesCheck = async (collective: any, extraString: string): Promise<string> => {
  const content = `${collective.slug.split('-').join(' ')} ${collective.name} ${collective.description} ${
    collective.longDescription
  } ${collective.website} ${extraString}`;

  const classifier = await getBayesClassifier();

  return classifier.categorize(content);
};

/**
 * Checks the values for this collective to try to determinate if it's a spammy profile.
 */
export const collectiveSpamCheck = async (collective: any, context: string): Promise<SpamAnalysisReport> => {
  const result = { score: 0, keywords: new Set<string>(), domains: new Set<string>() };

  let bayesCheck = null;
  if (collective.description || collective.longDescription) {
    bayesCheck = await collectiveBayesCheck(collective, '');
    if (bayesCheck === 'spam') {
      result.score += 0.5;
    }
  }

  ANALYZED_FIELDS.forEach(field => {
    // Check each field for SPAM keywords
    const suspiciousKeywords = getSuspiciousKeywords(collective[field] || '');
    suspiciousKeywords.forEach(keyword => {
      result.keywords.add(keyword);
      result.score += SPAM_KEYWORDS[keyword];
    });

    // Check for blocked domains
    const blockedDomains = getSpamDomains(collective[field] || '');
    if (blockedDomains.length) {
      blockedDomains.forEach(domain => result.domains.add(domain));
      result.score = 1;
    }
  });

  return {
    date: new Date().toISOString(),
    score: clamp(result.score, 0, 1),
    bayes: bayesCheck,
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
  return slackLib.postMessageToOpenCollectiveSlack(message, OPEN_COLLECTIVE_SLACK_CHANNEL.ABUSE);
};
