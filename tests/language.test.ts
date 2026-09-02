import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COMMON_LANGUAGES,
  effectiveLanguage,
  isLanguageCode,
  languageForIsbn,
  languageLabel,
  normalizeLanguageCode,
} from '../shared/language.ts';

test('a language code is two or three lowercase letters or empty', () => {
  for (const code of ['', 'en', 'no', 'nn', 'ger', 'zh']) assert.equal(isLanguageCode(code), true, code);
  for (const code of ['EN', 'e', 'engl', 'en-US', 'en ', '12', 'nb!']) assert.equal(isLanguageCode(code), false, code);
});

test('normalization folds what sources give into the stored code', () => {
  assert.equal(normalizeLanguageCode(' EN '), 'en');
  assert.equal(normalizeLanguageCode('en-US'), 'en');
  assert.equal(normalizeLanguageCode('en_GB'), 'en');
  // Library records use ISO 639-2; Bokmål is stored as the macrolanguage.
  assert.equal(normalizeLanguageCode('nob'), 'no');
  assert.equal(normalizeLanguageCode('nb'), 'no');
  assert.equal(normalizeLanguageCode('nno'), 'nn');
  assert.equal(normalizeLanguageCode('eng'), 'en');
  assert.equal(normalizeLanguageCode('ger'), 'de');
  assert.equal(normalizeLanguageCode('deu'), 'de');
  // An unknown three-letter code is kept as a code; junk is unknown.
  assert.equal(normalizeLanguageCode('xyz'), 'xyz');
  assert.equal(normalizeLanguageCode('English'), '');
  assert.equal(normalizeLanguageCode(''), '');
  assert.equal(normalizeLanguageCode('e'), '');
});

test('an edition overrides the work only when it says something', () => {
  assert.equal(effectiveLanguage('', 'no'), 'no');
  assert.equal(effectiveLanguage('en', 'no'), 'en');
  assert.equal(effectiveLanguage('', ''), '');
});

test('labels name the language and fall back to the code', () => {
  assert.equal(languageLabel('en'), 'English');
  assert.equal(languageLabel('no'), 'Norwegian');
  assert.equal(languageLabel('nn'), 'Norwegian Nynorsk');
  assert.equal(languageLabel(''), '');
  assert.equal(languageLabel('xyz'), 'xyz');
  for (const {code, label} of COMMON_LANGUAGES) {
    assert.equal(isLanguageCode(code), true, code);
    assert.equal(languageLabel(code), label, code);
  }
});

test('the ISBN registration group names the language area, longest prefix first', () => {
  assert.equal(languageForIsbn('9780441478125'), 'en');
  assert.equal(languageForIsbn('9781234567897'), 'en');
  assert.equal(languageForIsbn('9788205394810'), 'no');
  assert.equal(languageForIsbn('9783161484100'), 'de');
  assert.equal(languageForIsbn('9788301000000'), 'pl');
  assert.equal(languageForIsbn('9788700000000'), 'da');
  assert.equal(languageForIsbn('9789979000000'), 'is');
  assert.equal(languageForIsbn('9791000000000'), 'fr');
  assert.equal(languageForIsbn('9798000000000'), 'en');
  // International agencies and areas this table does not know are unknown.
  assert.equal(languageForIsbn('9789200000000'), '');
  assert.equal(languageForIsbn('9789300000000'), '');
  assert.equal(languageForIsbn(''), '');
});
