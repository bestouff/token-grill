// The Translator the unit tests give to the core modules: the English msgids as they are.
export const UNTRANSLATED = {
    _: text => text,
    ngettext: (singular, plural, count) => count === 1 ? singular : plural,
};
