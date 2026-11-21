'use strict';

// 逐个检查受控译文对应的原槽，验证混合容器的直属正文与嵌套段落。
// 此函数可直接序列化到浏览器；只读取 DOM，不为缺失的片段创建标记或译文。
function inspectFixtureTranslationParts({parts, requireAll = false}, root = document) {
  const prefix = '测试译文：';
  const normalize = value => String(value ?? '').replace(/\s+/gu, ' ').trim();
  const decode = globalThis.__frAdaptationFixtureDecode;
  const originalText = value => decode ? decode(value, () => true) : value.replaceAll(prefix, '');
  const matchesMarkupText = (text, expected) => {
    if (decode && expected.startsWith(prefix)) return text.startsWith(prefix) && originalText(text) === expected.slice(prefix.length);
    return text === expected;
  };
  const result = parts.map(part => {
    const targets = [...root.querySelectorAll(part.selector)];
    const wrappers = targets.length === 1
      ? [...targets[0].children].filter(node => node.matches('.fluent-read-bilingual-content')) : [];
    const raw = String(wrappers[0]?.textContent ?? '');
    const text = normalize(raw);
    // The browser runner supplies the reversible codec. The standalone DOM
    // contract also accepts the legacy test prefix for authored unit fixtures.
    const source = normalize(originalText(raw));
    const translated = targets.length === 1 && wrappers.length === 1 && /[\u3400-\u9fff]/u.test(text)
      && source.includes(normalize(part.sourceIncludes))
      && (part.preservedText ?? []).every(value => text.includes(normalize(value)))
      && (part.omittedText ?? []).every(value => !source.includes(normalize(value)))
      && (part.preservedMarkup ?? []).every(expected =>
        [...wrappers[0].querySelectorAll(expected.selector)].some(node => matchesMarkupText(node.textContent, expected.text)));
    return {selector: part.selector, targetCount: targets.length, wrapperCount: wrappers.length, text, translated};
  });
  return requireAll ? result.every(part => part.translated) : result;
}

module.exports = {inspectFixtureTranslationParts};
