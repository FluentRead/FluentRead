'use strict';

// Self-contained host documents: no live website, image, font, or provider traffic.
// Stable fixture markers are authored here rather than written into host content by the runner.
const escapeHtml = value => String(value).replace(/[&<>"']/gu, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));
const marker = (kind, index, part) => `LPM-${kind.toUpperCase()}-${String(index).padStart(3, '0')}-${part}`;
const paragraph = (kind, index, part, extra = '', attributes = '', focus = false) => {
  const token = marker(kind, index, part);
  return `<p id="source-${token}" data-long-required data-long-source="${token}"${attributes}${focus ? ' data-long-special="focus"' : ''}>${token}: Careful readers compare several observations before drawing a conclusion. The surrounding evidence describes a reproducible experiment, its assumptions, and the remaining uncertainty. A <a href="#fixture-end" data-long-link>related explanation</a> provides additional context, and <em>this emphasized clause</em> remains part of the original sentence.${extra}${focus ? ' The inline token <code>focus_token</code> remains exact while the safe link stays usable.' : ''}</p>`;
};

function buildLongPageFixture(kind, units = 60) {
  if (!['discussion', 'article', 'research'].includes(kind)) throw new Error(`Unknown long-page fixture: ${kind}`);
  if (!Number.isInteger(units) || units < 12 || units > 160) throw new Error('Fixture units must be an integer from 12 through 160');
  const guard = (id, html, tag = 'div', attributes = '') => `<${tag} id="guard-${id}" data-long-guard translate="no" ${attributes}>${html}</${tag}>`;
  const navigation = guard('navigation', '<a href="#fixture-end">Archive</a> <a href="#fixture-top">Home</a>', 'nav');
  const controls = guard('controls', '<label>Search <input type="search" value="fixed search text"></label><button type="button" onclick="window.__longFixtureClicks=(window.__longFixtureClicks||0)+1">Keep reading</button>');
  let body;
  if (kind === 'discussion') {
    body = `<table id="hnmain"><tbody><tr><td><span class="pagetop" data-long-guard id="guard-hn-navigation">${navigation}</span></td></tr><tr><td><span class="titleline"><a href="#fixture-end">A controlled discussion about reliable measurements</a></span></td></tr><tr><td class="subtext" data-long-guard id="guard-hn-score"><span class="score">42 points</span> by <a class="hnuser" href="#fixture-end">fixture_author</a></td></tr><tr><td>${controls}<table class="comment-tree"><tbody>${Array.from({length: units}, (_, index) => `<tr class="athing comtr" id="comment-${index}"><td><div class="comhead" data-long-guard id="guard-author-${index}"><a class="hnuser" href="#fixture-end">fixture_author_${index}</a> <span class="age">one hour ago</span></div><div class="comment"><span class="commtext c00" data-long-container>${marker(kind, index, 'opening')}: This opening comment explains the experiment before its independent paragraphs.${paragraph(kind, index, 0, '', '', index === units - 1)}${paragraph(kind, index, 1)}${guard(`code-${index}`, '<code>const unchanged = "fixture code";</code>', 'pre')}</span></div><div class="reply" data-long-guard id="guard-reply-${index}"><a href="#fixture-end">reply</a></div></td></tr>`).join('')}</tbody></table></td></tr></tbody></table>`;
  } else if (kind === 'article') {
    body = `${navigation}${controls}<main><article id="fixture-content"><h1>A long article about reproducible browser experiments</h1>${Array.from({length: units}, (_, index) => `<section data-long-container${index === 2 ? ' data-long-float-case style="display:flow-root"' : ''}><h2>Observation ${index + 1}</h2>${index === 2 ? '<div data-long-guard id="guard-float" aria-hidden="true" style="float:left;width:220px;height:250px;margin:0 22px 16px 0;background:#dbe7ef;border-radius:6px"></div>' : ''}${paragraph(kind, index, 0, index === 4 ? ` <code>UnbrokenIdentifier_${'W'.repeat(240)}</code>` : '', index === 4 ? ' data-long-special="overflow"' : '', index === units - 1)}${paragraph(kind, index, 1)}${index % 6 === 0 ? guard(`code-${index}`, '<code>for (const item of observations) inspect(item);</code>', 'pre') : ''}</section>`).join('')}</article></main>`;
  } else {
    body = `${navigation}${controls}<main><article id="fixture-content"><h1>Rendering Cost in Long Bilingual Documents</h1>${guard('paper-authors', 'Ada Fixture, Ben Example · October 2026', 'address')}<section><h2>Abstract</h2><p data-long-source="abstract">This controlled HTML paper investigates the cost of rendering translated content and preserves mathematical notation separately.</p></section>${Array.from({length: units}, (_, index) => `<section data-long-container><h2>Experiment ${index + 1}</h2>${paragraph(kind, index, 0)}${paragraph(kind, index, 1, '', '', index === units - 1)}${paragraph(kind, index, 2)}${guard(`formula-${index}`, '<span class="katex"><span class="katex-mathml"><math xmlns="http://www.w3.org/1998/Math/MathML"><mi>E</mi><mo>=</mo><mi>m</mi><msup><mi>c</mi><mn>2</mn></msup></math></span></span>', 'div')}<figure><figcaption>Figure ${index + 1}. A comparison of the measured observations.</figcaption></figure></section>`).join('')}</article></main>`;
  }
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Long page mock: ${escapeHtml(kind)}</title><style>
    :root { font-family: Arial, sans-serif; color: #20242a; background: #fff; }
    body { max-width: 840px; margin: 24px auto; padding: 0 36px; font-size: 18px; line-height: 1.65; }
    p { margin: 16px 0 24px; } h1,h2 { line-height: 1.3; } h2 { margin-top: 34px; }
    table { border-collapse: collapse; width: 100%; } td { vertical-align: top; }
    .comtr > td { padding: 18px 0; border-bottom: 1px solid #d5d8dc; }
    .comhead,.subtext,.reply,address { font-size: 13px; color: #68707a; }
    pre { white-space: pre-wrap; background: #f1f3f5; padding: 12px; }
    nav, #guard-controls { padding: 12px 0; } a { color: #1855ad; } button,input { font: inherit; }
    figure { margin: 20px 0; } .katex { font-family: serif; }
    /* The source and its preserved inline code must genuinely overflow even when prose wraps. */
    [data-long-special="overflow"] code { white-space: nowrap; word-break: normal; overflow-wrap: normal; }
    /* Test-only same-DOM control; the default fixture does not carry this root flag. */
    html[data-long-render-control="visible"] .fluent-read-bilingual-content[data-fr-translation-owned="true"] {
      content-visibility: visible !important; contain-intrinsic-block-size: none !important;
    }
    @media print { body { max-width: none; margin: 0; font-size: 12pt; } nav, #guard-controls { display: none; } }
  </style></head><body id="fixture-top">${body}<footer id="fixture-end" data-long-guard translate="no">End of controlled fixture</footer></body></html>`;
  return {
    id: kind,
    url: kind === 'discussion' ? 'https://news.ycombinator.com/item?id=999999998' : `https://example.com/fluentread-long-${kind}`,
    units,
    requiredCount: units * (kind === 'research' ? 3 : 2),
    html,
  };
}

module.exports = {buildLongPageFixture};
