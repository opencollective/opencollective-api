import fs from 'fs';
import path from 'path';

import bayes from 'bayes';
import config from 'config';
import getUrls from 'get-urls';
import { clamp } from 'lodash';
import sanitizeHtml from 'sanitize-html';

import slackLib, { OPEN_COLLECTIVE_SLACK_CHANNEL } from '../lib/slack';
import { Collective } from '../models';
import { Activity } from '../models/Activity';

/** Return type when running a spam analysis */
export type SpamAnalysisReport = {
  /** When did the report occur */
  date: string;
  /** What's the context of the report */
  context: string;
  /** Data of the entity that was analyzed */
  data: Record<string, unknown>;
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
  categorize(content: string): string;
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
  assignment: 0.3,
  canzana: 0.3,
  casino: 0.2,
  cbd: 0.3,
  ciagra: 0.3,
  cream: 0.1,
  credit: 0.2,
  escort: 0.3,
  essay: 0.2,
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

// Any domain from there gives you a SPAM score of 1
export const SPAMMERS_DOMAINS = [
  '1.bp.blogspot.com',
  '500px.com',
  '513-ohio-ads.com',
  '7smabu.com',
  'abellarora.com',
  'addwish.com',
  'adskorner.com',
  'adsyellowpages.com',
  'adulted.instructure.com',
  'advertise.lachanalebrand.com',
  'advisoroffer.com',
  'afterhourshealth.com',
  'agarioforums.net',
  'agencymumbai.com',
  'airtravelmart.com',
  'alertpills.com',
  'alexanderstamps.com',
  'allnutritionhub.com',
  'allsupplementshop.com',
  'alpha.trinidriver.com',
  'amazonhealthmart.com',
  'amirarticles.com',
  'animale-male-enhancement-au-nz.company.site',
  'animale-male-enhancement-au-nz.webflow.io',
  'animale-male-enhancement-australia-nz.webflow.io',
  'animale-male-enhancement-south-africa-z.webflow.io',
  'animale-male-enhancement-za.company.site',
  'animale-male-enhancement-za.webflow.io',
  'anime-planet.com',
  'antiwrinklecream20.wixsite.com',
  'anyflip.com',
  'aopendoor.com',
  'apnews.com',
  'apsense.com',
  'archives.profsurv.com',
  'artio.net',
  'atozfitnesstalks.com',
  'avengersdiet.com',
  'b-webdesign.org',
  'base2edu.instructure.com',
  'bebee.com',
  'benzinga.com',
  'besttacticalwatch.wixsite.com',
  'bhitmagazine.com.ng',
  'bibrave.com',
  'biiut.com',
  'bitsdujour.com',
  'biznutra.com',
  'biznutrition.com',
  'blackworldforum.com',
  'bluesoleil.com',
  'bollyshake.com',
  'bonfire.com',
  'bookishelf.com',
  'bookmarkextent.com',
  'buddysupplement.com',
  'bumpsweat.com',
  'butywolka.eu',
  'butywolka.pl',
  'buypurelifeketo.com',
  'buzrush.com',
  'callgirldehradun.com',
  'callgirlsindelhi.co.in',
  'callupcontact.com',
  'camobear.ca',
  'canvas.elsevier.com',
  'canvas.msstate.edu',
  'canvas.pbsteacherline.org',
  'canvas.redejuntos.org.br',
  'caramellaapp.com',
  'carookee.de',
  'cartelhealth.com',
  'cashforhomespittsburgh.com',
  'cerld.com',
  'change-that-up-prostatep4.webflow.io',
  'chordie.com',
  'classifieds.usatoday.com',
  'clck.ru',
  'clinicabalu.com',
  'club.vexanium.com',
  'colab.research.google.com',
  'cole2.uconline.edu',
  'communities.bentley.com',
  'community.hpe.com',
  'community.robo3d.com',
  'community.roku.com',
  'completefoods.co',
  'consultbestastro.com',
  'copymethat.com',
  'coub.com',
  'create.arduino.cc',
  'creativehealthcart.com',
  'creativemarket.com',
  'csopartnership.org',
  'cursedmetal.com',
  'cutt.us',
  'dailydealsreview.info',
  'dakhoaquoctehanoi.webflow.io',
  'dakshi.in',
  'darknetweed.com',
  'dasilex.co.uk',
  'deadlinenews.co.uk',
  'dealanddeals.pk',
  'deepai.org',
  'demandsupplement.com',
  'demo.evolutionscript.com',
  'designyourown.pk',
  'deutschlandsupplements.de',
  'diaetolin-deutschland-2013.company.site',
  'diaetolin-deutschland-de-at-ch.webflow.io',
  'diaetoxilnederlandprice.company.site',
  'dibiz.com',
  'dietarypillsstore.com',
  'dietdoctor.com',
  'diets2try.com',
  'diffdrum.co.uk',
  'digitalvisi.com',
  'djpod.com',
  'doescbdoilwork.com',
  'dr.gr',
  'dragonsdenketo.com',
  'dridainfotech.com',
  'droidt99.com',
  'dyskn-cream-usa.webflow.io',
  'ecuadortransparente.org',
  'edu-24.info',
  'elitecaretreatment.com',
  'examine24x7.com',
  'expatriates.com',
  'faculdadearidesa.instructure.com',
  'falseceilingexperts.in',
  'faqssupplement.com',
  'farm1.staticflickr.com',
  'farmscbdoil.com',
  'feedsfloor.com',
  'figur-capsules-uk-ie.company.site',
  'figur-nederland-9eb75e.webflow.io',
  'figur-nederland-nl.company.site',
  'figur-nederland-nl.webflow.io',
  'figur-nederland.jimdosite.com',
  'figur-nederland34.company.site',
  'figur-nederlands-dapper-site.webflow.io',
  'figur-united-kingdom-ie-uk.webflow.io',
  'figur-united-kingdom-uk-price.webflow.io',
  'finance.yahoo.com',
  'fitcareketo.com',
  'fitdiettrends.com',
  'fitdiettrendz.com',
  'fitnesscarezone.com',
  'fitnessdietreviews.com',
  'fitnessmegamart.com',
  'fitnessprocentre.com',
  'fitpedia.org',
  'fleming.desire2learn.com',
  'fordtremor.com',
  'forexinthai.com',
  'foro.testdevelocidadinternet.com',
  'forum.9dots.de',
  'forum.fusioncharts.com',
  'forum.techtudo.globo.com',
  'forum.zidoo.tv',
  'forums.magicengine.com',
  'francesupplements.fr',
  'freetrailhealth.com',
  'frogdoch.ch',
  'gab.com',
  'getyouroffers.xyz',
  'gfycat.com',
  'globenewswire.com',
  'gocrowdera.com',
  'goketogenics.com',
  'gooddiets.co.uk',
  'gotartwork.com',
  'greenandgoldrugby.com',
  'gurgaonescorts.in',
  'health4trend.com',
  'healthcarthub.com',
  'healthline.com',
  'healthlinenutrition.com',
  'healthmassive.com',
  'healthmife.com',
  'healthnsupplements.com',
  'healthonlinecare.com',
  'healthpubmed.com',
  'healthsupplementcart.com',
  'healthtalkrev.blogspot.com',
  'healthtalkrev.com',
  'healthtalkrevfacts.blogspot.com',
  'healthverbs.com',
  'healthyaustralia.com.au',
  'healthycliq.com',
  'healthygossips.com',
  'healthymenuforchildren.blogspot.com',
  'healthynutrishop.com',
  'healthyslimdiet.com',
  'healthytalkz.com',
  'hearthis.at',
  'herbal-care-products.com',
  'herbalsupplementreview.com',
  'herbalweightlossreview.com',
  'hmdsupplements.com',
  'hogheavenbar-b-que.com',
  'homify.com',
  'homify.in',
  'hulkdiet.com',
  'hulkpills.com',
  'hulksupplement.com',
  'hyalurolift.fr',
  'hybridwatchshop.wixsite.com',
  'hype.news',
  'icefabrics.com',
  'identifyscam.com',
  'iexponet.com',
  'image.makewebeasy.net',
  'industrialcleaningpros.com',
  'influence.co',
  'infogram.com',
  'inkitt.com',
  'innovationdiet.com',
  'inova.instructure.com',
  'insta-keto.org',
  'intensedebate.com',
  'ipsnews.net',
  'isajain.com',
  'italianiintegratori.it',
  'itsmyurls.com',
  'jagritimalhotra.org',
  'janvhikapoor.com',
  'jobhub.live',
  'jotform.com',
  'justgiving.com',
  'kandiez.co.ke',
  'keto-bodytone.com',
  'keto-excel-keto-gummies-au-nz-price.webflow.io',
  'keto-excel-keto-gummies-au-nz.company.site',
  'keto-top.org',
  'keto-ultra-diet.com',
  'ketoadvanced74.blogspot.com',
  'ketoboostx.com',
  'ketodietfitness.com',
  'ketodietsplan.com',
  'ketodietstores.com',
  'ketodietwalmart.com',
  'ketoerfahrungendeutschland.de',
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
  'kit.co',
  'knowyourmeme.com',
  'ktc.instructure.com',
  'kursovezavseki.com',
  'lakubet.co',
  'laroc-derma-cream-canada.webflow.io',
  'larocdermacream467.company.site',
  'laweekly.com',
  'lawrence.com',
  'learningatpanania.com.au',
  'lets-keto-apple-gummies-au-nz-ca.company.site',
  'lets-keto-apple-gummies-au-nz-ca.webflow.io',
  'lets-keto-apple-gummies-au-nz-canada.webflow.io',
  'lets-keto-apple-gummies-uk-price.webflow.io',
  'lets-keto-australia-au-nz.company.site',
  'lets-keto-australia.webflow.io',
  'lets-keto-capsules-za.company.site',
  'lets-keto-gummies-canada-ca.company.site',
  'lets-keto-gummies-south-africa-za.webflow.io',
  'lets-keto-gummies-uk.company.site',
  'lets-keto-gummies-za-price.company.site',
  'lexcliq.com',
  'lifetime-keto-acv-gummies-2023.company.site',
  'lifetime-keto-acv-gummies-usa-price.webflow.io',
  'linkhay.com',
  'logisticmart.com',
  'longisland.com',
  'lunaireketobhb.blogspot.com',
  'mafiatek.my.id',
  'maleenhancementtips.com',
  'mariamd.com',
  'market.acesinvensys.com',
  'marketwatch.com',
  'mastersindia.co',
  'medixocentre.com',
  'medlineplus.gov',
  'menhealthdiets.com',
  'merchantcircle.com',
  'mindsumo.com',
  'minimore.com',
  'morioh.com',
  'mrxmaleenhancement-point.blogspot.com',
  'muckrack.com',
  'my.desktopnexus.com',
  'myanimelist.net',
  'myfitnesspharm.com',
  'myshorturl.net',
  'myunbiasedreview.wordpress.com',
  'nananke.com',
  'naturalketopill.com',
  'nbclh.app.link',
  'netchorus.com',
  'netgearextendersetupp.com',
  'netrockdeals.com',
  'nhadat24.org',
  'norgekosttilskudd.no',
  'norton.com',
  'note.com',
  'nutraplatform.com',
  'nutrifitweb.com',
  'nutriminimart.com',
  'nutritioun.com',
  'offer4cart.com',
  'offernutra.com',
  'office.com',
  'officemaster.ae',
  'onlineairlinesbooking.com',
  'onlinereservationbooking.com',
  'onnitsupplements.com',
  'openclassrooms.com',
  'openeyetap.com',
  'oppsofts.com',
  'orderfitness.org',
  'organicsupplementdietprogram.com',
  'ourunbiasedreview.blogspot.com',
  'outlookindia.com',
  'paper.li',
  'passportphotonow.co.uk',
  'paste.softver.org.mk',
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
  'play.flixmax.stream',
  'pornlike.net',
  'praltrix.info',
  'prima-weight-loss-capsules-italia.webflow.io',
  'prlog.org',
  'products99.com',
  'promosimple.com',
  'provenexpert.com',
  'pubhtml5.com',
  'publons.com',
  'purefiter.com',
  'purefitketopills.com',
  'purnimasingh.com',
  'quesanswer.com',
  'quickfinds.in',
  'realbuzz.com',
  'redrealestate.com.pk',
  'reefmaster.com.au',
  'regalketo17.lighthouseapp.com',
  'rembachduong.vn',
  'reseau.1mile.com',
  'reurl.cc',
  'reviewmypills.com',
  'reviewography.com',
  'reviewsbox.org',
  'reviewsbox360.wixsite.com',
  'reviewscart.co.uk',
  'richardpeppard.com.au',
  'riovista.instructure.com',
  'rise-up.co.uk',
  'riteketopills.com',
  'rolonet.com',
  'saatchiart.com',
  'sahulatcenter.com',
  'saturdaysale.com',
  'sco.lt',
  'sg.wantedly.com',
  'shadowville.com',
  'shanorady.medium.com',
  'shaobinli.is-programmer.com',
  'sharktankdiets.com',
  'shortest.activeboard.com',
  'shwetabasu.com',
  'shwetachopra.com',
  'sites.duke.edu',
  'sites.psu.edu',
  'situsslots.net',
  'sj1250710.wixsite.com',
  'skatafka.com',
  'sketchfab.com',
  'slimketopills.com',
  'smashboards.com',
  'smore.com',
  'snomoto.com',
  'socialnetwork.linkz.us',
  'softage.net',
  'soo.gd',
  'spa-india.azurewebsites.net',
  'spreaker.com',
  'srsmedicare.com',
  'stageit.com',
  'startupmatcher.com',
  'startus.cc',
  'staycure.com',
  'steroidscience.org',
  'streetgirls.in',
  'streetinsider.com',
  'stunxt.com',
  'sugarbalance.store',
  'sunnyspotrealty.net',
  'suphe.net',
  'supplement4muscle.com',
  'supplementarmy.com',
  'supplementblend.com',
  'supplementdose.com',
  'supplementenbelgie.be',
  'supplementgear.com',
  'supplementgo.com',
  'supplementrise.com',
  'supplementscare.co.za',
  'supplementslove.com',
  'supplementsnetherlands.nl',
  'supplementsnewzealand.co.nz',
  'supplementsonlinestore.com',
  'supplementspeak.com',
  'surveensaniya.com',
  'sverigetillskott.se',
  'sway.office.com',
  'switch-bot.com',
  'switzerlandsupplements.ch',
  'takeapills.com',
  'tans.ca',
  'tanyagupta.in',
  'tapas.io',
  'teamfeed.feedingamerica.org',
  'techplanet.today',
  'techrum.vn',
  'telegra.ph',
  'teletype.in',
  'termpapersite.com',
  'thebackplane.com',
  'thefitnesssupplement.com',
  'thefitnesssupplementshop.blogspot.com',
  'thehealthwind.com',
  'theimagingprofessionals.co.uk',
  'thenutritionvibe.com',
  'theredfork.org',
  'thietkevanan.com',
  'time2trends.com',
  'timeofhealth.info',
  'timeofhealth.org',
  'timesofnews24x7.com',
  'tocal.instructure.com',
  'toevolution.com',
  'topcbdoilhub.com',
  'topsitenet.com',
  'topusatrendpills.com',
  'totaldiet4you.com',
  'totalketopills.com',
  'toyorigin.com',
  'training.dwfacademy.com',
  'travelingpin.com',
  'trend.kukooo.com',
  'trentandallievan.com',
  'triberr.com',
  'tripoto.com',
  'trippleresult.com',
  'truman-plus-male-enhancement-usa.webflow.io',
  'tryittoday.xyz',
  'trypurenutrition.com',
  'uagcasestore.com.au',
  'uchearts.com',
  'udaipurqueen.com',
  'ultimate-guitar.com',
  'unews.tv',
  'unsplash.com',
  'usahealthpills.com',
  'vashikaranexlove.com',
  'verifiedexchange.com',
  'verywellweightloss.com',
  'viaketo-apple-gummies-france-2023.webflow.io',
  'viaketo-gummies-usa-canada-uk-au-nz.company.site',
  'videa.hu',
  'viki.com',
  'vingle.net',
  'vle.ar-raniry.ac.id',
  'wakelet.com',
  'warengo.com',
  'webcampornodirecto.es',
  'weddingwire.us',
  'wellnessketoz.com',
  'wfmj.com',
  'wheretocare.com',
  'wintersupplement.com',
  'wiseintro.co',
  'works.bepress.com',
  'worldcosplay.net',
  'worldgymdiet.com',
  'worthydiets.com',
  'wow-keto.com',
  'xn--testoultrasterreich-z6b.at',
  'yarabook.com',
  'yed.yworks.com',
  'zaraaktar.com',
  'zarakan.com',
  'zephyr.com.pl',
  'zobuz.com',
  'zupyak.com',
];

export const NON_SPAMMERS_DOMAINS = [
  'about.me',
  'angel.co',
  'behance.net',
  'bit.do',
  'bit.ly',
  'crunchbase.com',
  'dailymotion.com',
  'dev.to',
  'disqus.com',
  'docs.google.com',
  'dribbble.com',
  'emailmeform.com',
  'en.wikipedia.org',
  'facebook.com',
  'fda.gov',
  'form.jotform.com',
  'github.com',
  'givebutter.com',
  'gmail.com',
  'google.com',
  'groups.google.com',
  'gumroad.com',
  'i.imgur.com',
  'img.over-blog-kiwi.com',
  'instagram.com',
  'is.gd',
  'issuu.com',
  'k12.instructure.com',
  'ko-fi.com',
  'linkedin.com',
  'linktr.ee',
  'm.facebook.com',
  'marketwatch.com',
  'medium.com',
  'mndepted.instructure.com',
  'moweb.com',
  'myspace.com',
  'ncbi.nlm.nih.gov',
  'opencollective-production.s3.us-west-1.amazonaws.com',
  'opencollective.com',
  'pinterest.com',
  'phpbb.com',
  'quora.com',
  'rb.gy',
  'reddit.com',
  's3.amazonaws.com',
  'scoop.it',
  'service.elsevier.com',
  'sites.google.com',
  'soundcloud.com',
  'surveymonkey.com',
  't.co',
  't.me',
  'teespring.com',
  'twitter.com',
  'utah.instructure.com',
  'wattpad.com',
  'youtu.be',
  'youtube.com',
  'zenodo.org',
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

  const lowerCaseContent = content.toLowerCase();
  return SPAMMERS_DOMAINS.reduce((result, domain) => {
    if (lowerCaseContent.includes(domain)) {
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

const stringifyUrl = url => {
  return url
    .replace('http://', '')
    .replace('https://', '')
    .split('/')
    .join(' ')
    .split('-')
    .join(' ')
    .split('.')
    .join(' ')
    .split('?')
    .join(' ')
    .split('=')
    .join(' ')
    .split('&')
    .join(' ')
    .split('#')
    .join(' ');
};

const addLine = (message: string, line: string): string => (line ? `${message}\n${line}` : message);

export const collectiveBayesContent = async (collective: Collective, extraString = ''): Promise<string> => {
  const slugString = (collective.slug || '').split('-').join(' ');
  const websiteString = stringifyUrl(collective.website || '');

  const urls = getUrls(collective.longDescription || '');
  const urlsString = [...urls].map(stringifyUrl).join(' ');

  const longDescriptionString = sanitizeHtml(collective.longDescription || '', {
    allowedTags: [],
    allowedAttributes: {},
  });

  return `${slugString} ${collective.name} ${collective.description} ${longDescriptionString} ${urlsString} ${websiteString} ${extraString}`;
};

export const collectiveBayesCheck = async (collective: Collective, extraString = ''): Promise<string> => {
  const content = await collectiveBayesContent(collective, extraString);

  const classifier = await getBayesClassifier();

  return classifier.categorize(content);
};

/**
 * Checks the values for this collective to try to determinate if it's a spammy profile.
 */
export const collectiveSpamCheck = async (collective: Collective, context: string): Promise<SpamAnalysisReport> => {
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
    data: collective.info || (collective as unknown as Record<string, unknown>),
    context,
  };
};

/**
 * Post a message on Slack if the collective is suspicious
 */
export const notifyTeamAboutSuspiciousCollective = async (report: SpamAnalysisReport): Promise<void> => {
  const { score, keywords, domains, data } = report;
  let message = `*Suspicious collective data was submitted for collective:* https://opencollective.com/${data['slug']}`;
  message = addLine(message, `Score: ${score}`);
  message = addLine(message, keywords.length > 0 && `Keywords: \`${keywords.toString()}\``);
  message = addLine(message, domains.length > 0 && `Domains: \`${domains.toString()}\``);
  return slackLib.postMessageToOpenCollectiveSlack(message, OPEN_COLLECTIVE_SLACK_CHANNEL.ABUSE);
};

/**
 * Post a message on Slack when the expense is marked as spam
 */
export const notifyTeamAboutSpamExpense = async (activity: Activity): Promise<void> => {
  const { collective, expense, user } = activity.data;
  const expenseUrl = `${config.host.website}/${collective.slug}/expenses/${expense.id}`;
  const submittedByUserUrl = `${config.host.website}/${user.slug}`;

  let message = `*Expense was marked as spam:* ${expenseUrl}`;
  message = addLine(message, `Submitted by: ${submittedByUserUrl}`);
  return slackLib.postMessageToOpenCollectiveSlack(message, OPEN_COLLECTIVE_SLACK_CHANNEL.ABUSE);
};

/**
 * If URL is an open collective redirect, returns the redirect link.
 */
export const resolveRedirect = (parsedUrl: URL): URL => {
  if (
    parsedUrl.origin === config.host.website &&
    parsedUrl.pathname === '/redirect' &&
    parsedUrl.searchParams?.has('url')
  ) {
    try {
      return new URL(parsedUrl.searchParams.get('url'));
    } catch {
      // Ignore invalid redirect URLs
    }
  }

  return parsedUrl;
};
