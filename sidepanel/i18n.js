'use strict';

// Translations. The English text is the key: t('Run audit') looks up the
// message whose id is a hash of that text in _locales/<lang>/messages.json,
// and falls back to the English itself. $1, $2… are filled from the
// arguments. scripts/build-locales.py generates the message files from the
// t('…') calls in the code, using the same hash.

function msgKey(en) {
  let h = 5381;
  for (let i = 0; i < en.length; i++) h = ((h * 33) ^ en.charCodeAt(i)) >>> 0;
  return `m${h.toString(36)}`;
}

function t(en, ...subs) {
  let out = '';
  try { out = chrome.i18n.getMessage(msgKey(en), subs.map(String)); } catch { out = ''; }
  if (out) return out;
  return subs.length ? String(en).replace(/\$(\d)/g, (_, i) => String(subs[i - 1] ?? '')) : String(en);
}

/**
 * Translate static markup: elements with data-i18n (their inner HTML is the
 * English key) and data-i18n-label (their aria-label). Sets <html lang> to
 * the interface language when there's a translation for it.
 */
function localizePage(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    const en = el.innerHTML.trim().replace(/\s+/g, ' ');
    const out = t(en);
    if (out !== en) el.innerHTML = out;
  }
  for (const el of root.querySelectorAll('[data-i18n-label]')) el.setAttribute('aria-label', t(el.getAttribute('aria-label')));
  try {
    if (t('Run audit') !== 'Run audit') document.documentElement.lang = chrome.i18n.getUILanguage();
  } catch { /* outside the extension */ }
}

/** A check's summary in the reader's language: its translatable parts if the engine sent them. */
function summaryText(c) {
  return c.summaryParts ? c.summaryParts.map(([tpl, ...args]) => t(tpl, ...args)).join(' ') : t(c.summary || '');
}

/** Singular or plural English source, with the count as $1. */
function tn(n, one, many, ...subs) {
  return t(n === 1 ? one : many, n.toLocaleString(), ...subs);
}
