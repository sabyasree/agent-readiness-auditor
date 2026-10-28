'use strict';

// Suggest an accessible name for an unnamed control or image with Chrome's
// built-in model (Gemini Nano), from what the audit saw around it. Runs on
// the device; nothing leaves the browser.

const NAME_SYSTEM = 'You name web page controls and images for screen readers and AI agents. ' +
  'Reply with a short name: 1 to 5 words, sentence case, no quotes. For a button or link, say what it does ' +
  '(like "Search", "Open cart", "Next slide"). For an image, say what it shows. Use the page text you are given; do not invent product names.';

const NAME_SCHEMA = { type: 'object', properties: { name: { type: 'string', maxLength: 50 } }, required: ['name'] };

/** Whether a suggested fix has a name the model could improve. */
function fixNeedsName(f) {
  return !!(f.fix && f.hint && /(aria-label|alt)="/.test(f.fix));
}

async function suggestName(f) {
  const session = await LanguageModel.create({
    initialPrompts: [{ role: 'system', content: NAME_SYSTEM }],
    expectedInputs: AT_LANG,
    expectedOutputs: AT_LANG,
  });
  try {
    const current = (f.fix.match(/(?:aria-label|alt)="([^"]*)"/) || [])[1] || '';
    const prompt = `Element: ${f.snippet}\n${f.hint}\nCurrent placeholder: ${current}\n\nSuggest the name.`;
    const out = JSON.parse(await session.prompt(prompt, { responseConstraint: NAME_SCHEMA }));
    return String(out.name || '').replace(/["<>]/g, '').trim().slice(0, 50);
  } finally {
    session.destroy();
  }
}

/** The fix with its label replaced by `name`, and the "guess" comment updated. */
function applyName(fix, name) {
  return fix
    .replace(/((?:aria-label|alt)=")[^"]*(")/, `$1${name.replace(/&/g, '&amp;')}$2`)
    .replace(/\n<!--[^]*?-->/, '\n<!-- Name suggested by on-device AI. Check it says what the control does. -->');
}

/** "Suggest a name" for a finding's fix block; only shown when the on-device model is usable. */
function suggestNameButton(f, pre) {
  if (!fixNeedsName(f)) return null;
  const btn = h('button', { class: 'btn btn-quiet btn-small', type: 'button', hidden: true }, t('Suggest a name'));
  aiAvailability().then((a) => { btn.hidden = a === 'unavailable'; });
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = t('Thinking…');
    try {
      const name = await suggestName(f);
      if (!name) throw new Error('empty');
      f.fix = applyName(f.fix, name);
      pre.textContent = f.fix;
      if (state.report) saveReport(state.tabId, state.report);
      btn.textContent = t('Suggest another');
    } catch {
      toast(t('Couldn’t get a suggestion. Chrome’s built-in AI may still be downloading.'));
      btn.textContent = t('Suggest a name');
    } finally {
      btn.disabled = false;
    }
  });
  return btn;
}
