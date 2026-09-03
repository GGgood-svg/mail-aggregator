(function () {
  const SUPPORTED = new Set(['zh-CN', 'en-US', 'ja-JP', 'ko-KR', 'es-ES', 'fr-FR', 'de-DE']);
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'CODE', 'PRE', 'TEXTAREA']);
  let messages = {};
  let locale = 'zh-CN';
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });

  function normalize(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function translateTextNode(node) {
    if (!node || !node.parentElement || SKIP_TAGS.has(node.parentElement.tagName)) return;
    if (node.parentElement.closest('[data-i18n-skip]')) return;
    const source = normalize(node.nodeValue);
    const translated = messages[source];
    if (!source || !translated || translated === source) return;
    const leading = node.nodeValue.match(/^\s*/)[0];
    const trailing = node.nodeValue.match(/\s*$/)[0];
    node.nodeValue = `${leading}${translated}${trailing}`;
  }

  function translateElement(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE || SKIP_TAGS.has(element.tagName)) return;
    if (element.hasAttribute('data-i18n-skip')) return;
    for (const attribute of ['placeholder', 'title', 'aria-label']) {
      if (!element.hasAttribute(attribute)) continue;
      const source = normalize(element.getAttribute(attribute));
      if (messages[source]) element.setAttribute(attribute, messages[source]);
    }
    for (const child of element.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) translateTextNode(child);
      else if (child.nodeType === Node.ELEMENT_NODE) translateElement(child);
    }
  }

  async function loadPack(language) {
    if (language === 'zh-CN') return {};
    const english = await fetch('/i18n/en-US.json', { cache: 'no-cache' }).then((r) => r.json());
    if (language === 'en-US') return english.translations || {};
    const selected = await fetch(`/i18n/${language}.json`, { cache: 'no-cache' }).then((r) => r.json());
    return { ...(english.translations || {}), ...(selected.translations || {}) };
  }

  async function initialize() {
    try {
      const branding = await fetch('/api/branding', { credentials: 'same-origin', cache: 'no-cache' })
        .then((response) => response.json());
      locale = SUPPORTED.has(branding.web_language) ? branding.web_language : 'zh-CN';
      messages = await loadPack(locale);
      document.documentElement.lang = locale;
      translateElement(document.documentElement);
      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          if (mutation.type === 'characterData') translateTextNode(mutation.target);
          for (const node of mutation.addedNodes) {
            if (node.nodeType === Node.TEXT_NODE) translateTextNode(node);
            else if (node.nodeType === Node.ELEMENT_NODE) translateElement(node);
          }
        }
      });
      observer.observe(document.body, { subtree: true, childList: true, characterData: true });
      window.dispatchEvent(new CustomEvent('mail-aggregator-language-ready', { detail: { locale } }));
    } catch (error) {
      console.warn('[i18n] language pack unavailable:', error.message);
    } finally {
      resolveReady({ locale });
    }
  }

  window.I18n = {
    get locale() { return locale; },
    t(source) { return messages[normalize(source)] || source; },
    translateTree: translateElement,
    supported: [...SUPPORTED],
    ready,
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize);
  else initialize();
})();
