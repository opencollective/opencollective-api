import { expect } from 'chai';
import config from 'config';

import {
  buildSanitizerOptions,
  generateSummaryForHTML,
  sanitizeHTML,
  stripHTML,
} from '../../../server/lib/sanitize-html.js';

const fullContent = `
<h1>Ergo illi intellegunt quid Epicurus dicat, ego non intellego?</h1>
<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit. Miserum hominem! Si dolor summum malum est, dici aliter non potest. Igitur neque stultorum quisquam beatus neque sapientium non beatus. Duo Reges: constructio interrete. <i>Suo genere perveniant ad extremum;</i> Atqui pugnantibus et contrariis studiis consiliisque semper utens nihil quieti videre, nihil tranquilli potest. </p>
<ol>
  <li>Quando enim Socrates, qui parens philosophiae iure dici potest, quicquam tale fecit?</li>
  <li>Haec quo modo conveniant, non sane intellego.</li>
  <li>Ab his oratores, ab his imperatores ac rerum publicarum principes extiterunt.</li>
</ol>
<p><b>Honesta oratio, Socratica, Platonis etiam.</b> Quis non odit sordidos, vanos, leves, futtiles? <b>Quid dubitas igitur mutare principia naturae?</b> <i>Omnis enim est natura diligens sui.</i> Semper enim ita adsumit aliquid, ut ea, quae prima dederit, non deserat. </p>
<ul>
  <li>Si qua in iis corrigere voluit, deteriora fecit.</li>
  <li>Nec enim, dum metuit, iustus est, et certe, si metuere destiterit, non erit;</li>
  <li>Unum nescio, quo modo possit, si luxuriosus sit, finitas cupiditates habere.</li>
</ul>
<iframe width="560" height="315" src="https://www.youtube.com/embed/4in0wKB1jRU?start=461" frameborder="0" allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>
<pre>Illud vero minime consectarium, sed in primis hebes, illorum
scilicet, non tuum, gloriatione dignam esse beatam vitam.
</pre>
<table class="data">
  <thead>
    <tr>
      <th>Entry Header 1</th>
      <th>Entry Header 2</th>
      <th>Entry Header 3</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Entry Line 1</td>
      <td>Entry Line 2</td>
      <td>Entry Line 3</td>
    </tr>
  </tbody>
</table>
<blockquote cite="http://loripsum.net">
  Quid affers, cur Thorius, cur Caius Postumius, cur omnium horum magister, Orata, non iucundissime vixerit?
</blockquote>
<h2>Non laboro, inquit, de nomine.</h2>
<p><i>Ex rebus enim timiditas, non ex vocabulis nascitur.</i> Hoc loco discipulos quaerere videtur, ut, qui asoti esse velint, philosophi ante fiant. <a href="http://loripsum.net/" target="_blank">Dicimus aliquem hilare vivere;</a> Quae quidem sapientes sequuntur duce natura tamquam videntes; Nulla erit controversia. Si verbum sequimur, primum longius verbum praepositum quam bonum. Eorum enim omnium multa praetermittentium, dum eligant aliquid, quod sequantur, quasi curta sententia; </p>
`;

const fullContentStripped = `
Ergo illi intellegunt quid Epicurus dicat, ego non intellego?
Lorem ipsum dolor sit amet, consectetur adipiscing elit. Miserum hominem! Si dolor summum malum est, dici aliter non potest. Igitur neque stultorum quisquam beatus neque sapientium non beatus. Duo Reges: constructio interrete. Suo genere perveniant ad extremum; Atqui pugnantibus et contrariis studiis consiliisque semper utens nihil quieti videre, nihil tranquilli potest. 

  Quando enim Socrates, qui parens philosophiae iure dici potest, quicquam tale fecit?
  Haec quo modo conveniant, non sane intellego.
  Ab his oratores, ab his imperatores ac rerum publicarum principes extiterunt.

Honesta oratio, Socratica, Platonis etiam. Quis non odit sordidos, vanos, leves, futtiles? Quid dubitas igitur mutare principia naturae? Omnis enim est natura diligens sui. Semper enim ita adsumit aliquid, ut ea, quae prima dederit, non deserat. 

  Si qua in iis corrigere voluit, deteriora fecit.
  Nec enim, dum metuit, iustus est, et certe, si metuere destiterit, non erit;
  Unum nescio, quo modo possit, si luxuriosus sit, finitas cupiditates habere.


Illud vero minime consectarium, sed in primis hebes, illorum
scilicet, non tuum, gloriatione dignam esse beatam vitam.


  
    
      Entry Header 1
      Entry Header 2
      Entry Header 3
    
  
  
    
      Entry Line 1
      Entry Line 2
      Entry Line 3
    
  


  Quid affers, cur Thorius, cur Caius Postumius, cur omnium horum magister, Orata, non iucundissime vixerit?

Non laboro, inquit, de nomine.
Ex rebus enim timiditas, non ex vocabulis nascitur. Hoc loco discipulos quaerere videtur, ut, qui asoti esse velint, philosophi ante fiant. Dicimus aliquem hilare vivere; Quae quidem sapientes sequuntur duce natura tamquam videntes; Nulla erit controversia. Si verbum sequimur, primum longius verbum praepositum quam bonum. Eorum enim omnium multa praetermittentium, dum eligant aliquid, quod sequantur, quasi curta sententia; 
`;

const improperlyFormattedContent = `
  <div>Won't be fooled by your <script>alert("script")</script></p>!
  <script<p>content</p>alert("script")>alert("script")
`;

describe('server/lib/sanitize-html', () => {
  describe('stripHTML', () => {
    it("Doesn't allow anything", () => {
      expect(stripHTML(fullContent)).to.eq(fullContentStripped);
    });

    it('Works with improperly formatted content', () => {
      expect(stripHTML(improperlyFormattedContent)).to.eq(`
  Won't be fooled by your !
  contentalert("script")&gt;alert("script")
`);
    });
  });

  describe('sanitizeHTML + buildSanitizerOptions', () => {
    it('defaults to strip everything', () => {
      expect(sanitizeHTML(fullContent, buildSanitizerOptions())).to.eq(fullContentStripped);
      expect(sanitizeHTML(fullContent, buildSanitizerOptions({}))).to.eq(fullContentStripped);
    });

    it('Downcase big titles', () => {
      expect(sanitizeHTML('<h1>Hello World</h1>', buildSanitizerOptions({ titles: true }))).to.to.eq(
        '<h3>Hello World</h3>',
      );
    });

    it('allow videos', () => {
      expect(sanitizeHTML(fullContent, buildSanitizerOptions({ videoIframes: true }))).to.include(
        '<iframe width="560" height="315" src="https://www.youtube.com/embed/4in0wKB1jRU?start=461" frameborder="0" allow allowfullscreen>',
      );
    });

    it('redirects unstrusted domains', () => {
      const sanitizerOptions = buildSanitizerOptions({ links: true });
      expect(sanitizeHTML('<a href="https://malicious-domain.com">Test</a>', sanitizerOptions)).to.eq(
        '<a href="http://localhost:3000/redirect?url=https%3A%2F%2Fmalicious-domain.com">Test</a>',
      );
      expect(sanitizeHTML('<a href="http://malicious-domain.com/toto">Test</a>', sanitizerOptions)).to.eq(
        '<a href="http://localhost:3000/redirect?url=http%3A%2F%2Fmalicious-domain.com%2Ftoto">Test</a>',
      );
      expect(sanitizeHTML('<a href="malicious-domain.com/toto">Test</a>', sanitizerOptions)).to.eq(
        '<a href="http://localhost:3000/redirect?url=https%3A%2F%2Fmalicious-domain.com%2Ftoto">Test</a>',
      );
      expect(sanitizeHTML('<a href="opencollective.com.malicious.com">Test</a>', sanitizerOptions)).to.eq(
        '<a href="http://localhost:3000/redirect?url=https%3A%2F%2Fopencollective.com.malicious.com">Test</a>',
      );
      expect(sanitizeHTML('<a href="maliciousopencollective.com">Test</a>', sanitizerOptions)).to.eq(
        '<a href="http://localhost:3000/redirect?url=https%3A%2F%2Fmaliciousopencollective.com">Test</a>',
      );
    });

    it('does not redirect trusted domains', () => {
      const testUrls = [
        '<a href="https://opencollective.com/toto">Test</a>',
        '<a href="https://docs.opencollective.com/toto">Test</a>',
        '<a href="http://github.com/toto">Test</a>',
        '<a href="https://opencollective-test.s3.us-west-1.amazonaws.com/a83d7d30-f8e6-11ea-b187-e31017293ab6.jpg">Test</a>',
      ];

      const sanitizerOptions = buildSanitizerOptions({ links: true });
      testUrls.forEach(url => {
        expect(sanitizeHTML(url, sanitizerOptions)).to.eq(url);
      });
    });

    it('keeps external images when images is set', () => {
      expect(
        sanitizeHTML('Hello <img src="https://example.com/test.jpg"> World', buildSanitizerOptions({ images: true })),
      ).to.eq(`Hello <img src="https://example.com/test.jpg" /> World`);
    });

    it('strips external images when imagesInternal is set', () => {
      expect(
        sanitizeHTML(
          'Hello <img src="https://example.com/test.jpg"> World',
          buildSanitizerOptions({ imagesInternal: true }),
        ),
      ).to.eq(`Hello  World`);
    });
  });

  describe('generateSummaryForHTML', () => {
    it('Sanitizes, trim and truncate', () => {
      expect(generateSummaryForHTML(fullContent, 4)).to.to.eq('Ergo...');
      expect(generateSummaryForHTML(fullContent, 32)).to.to.eq('Ergo illi intellegunt quid Epicu...');
      expect(generateSummaryForHTML(fullContent.slice(272), 80)).to.to.eq(
        'Reges: constructio interrete. <i>Suo genere perveniant ad extremum;</i> Atqui pu...',
      );
      expect(generateSummaryForHTML(fullContent.slice(1000), 1000)).to.to.eq(
        `Si qua in iis corrigere voluit, deteriora fecit. Nec enim, dum metuit, iustus est, et certe, si metuere destiterit, non erit; Unum nescio, quo modo possit, si luxuriosus sit, finitas cupiditates habere. Illud vero minime consectarium, sed in primis hebes, illorum scilicet, non tuum, gloriatione dignam esse beatam vitam. Entry Header 1 Entry Header 2 Entry Header 3 Entry Line 1 Entry Line 2 Entry Line 3 Quid affers, cur Thorius, cur Caius Postumius, cur omnium horum magister, Orata, non iucundissime vixerit? Non laboro, inquit, de nomine. <i>Ex rebus enim timiditas, non ex vocabulis nascitur.</i> Hoc loco discipulos quaerere videtur, ut, qui asoti esse velint, philosophi ante fiant. <a href="${config.host.website}/redirect?url=http%3A%2F%2Floripsum.net%2F" target="_blank">Dicimus aliquem hilare vivere;</a> Quae quidem sapientes sequuntur duce natura tamquam videntes; Nulla erit controversia. Si verbum sequimur, primum longius verbum praepositum quam bonum. Eorum enim omnium multa praeter...`,
      );
    });

    it("Doesn't cut anchors", () => {
      expect(generateSummaryForHTML('Hey, Hi <strong>Hello World</strong>', 30)).to.to.eq(
        'Hey, Hi <strong>Hello</strong>...',
      );
    });

    it('Handle length properly with anchors', () => {
      expect(generateSummaryForHTML("I'd like to say <strong>Hello World</strong>", 30)).to.have.lengthOf.at.most(33);
    });

    it('Adds separator after titles', () => {
      expect(generateSummaryForHTML(`<h3>Mene ergo et Triarium</h3><p>Lorem ipsum dolor.</p>`, 150)).to.to.eq(
        'Mene ergo et Triarium · Lorem ipsum dolor.',
      );
    });

    it('Replaces newlines by spaces', () => {
      expect(generateSummaryForHTML(`Hello\nWorld<br/><br/>!\n\n\nOnly one space`, 40)).to.eq(
        'Hello World ! Only one space',
      );

      expect(
        generateSummaryForHTML(
          `<p>After a much ado, we created an easy way to donate to <a href="https://sagemath.org" target="_blank">SageMath</a> project.</p><p>Donations are US tax (IRC 501(c)(6)) deductible.  </p>`,
          240,
        ),
      ).to.eq(
        `After a much ado, we created an easy way to donate to <a href="${config.host.website}/redirect?url=https%3A%2F%2Fsagemath.org" target="_blank">SageMath</a> project. Donations are US tax (IRC 501(c)(6)) deductible.`,
      );
    });

    it('Handles utf-8 strings properly', () => {
      const frenchSample = `Une communauté, c'est de la confiance et du partage. Open Collective vous permet de gérer vos finances pour que tout le monde puisse voir d'où vient l'argent et où il va. Collectez et dépensez de l'argent de manière transparente. Recevez des fonds par carte de crédit, Paypal ou virement bancaire et enregistrez tout dans votre budget transparent. Définissez différentes façons de contribuer avec des niveaux et des récompenses personnalisables.`;
      for (const sampleLength of [40, 100, 240]) {
        expect(generateSummaryForHTML(frenchSample, sampleLength)).to.have.lengthOf.at.most(sampleLength + 3);
      }
    });

    it('Truncating tags in middle works as expected', () => {
      expect(generateSummaryForHTML("I'd like to say <strong>Hello World</strong>", 20)).to.to.eq("I'd like to say...");
    });
  });
});
