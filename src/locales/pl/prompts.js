// pl: domyślne szybkie akcje, persony i komunikaty ustawień (src/lib/prompts.js, src/lib/settings.js).
// Only names and labels: the default prompt texts come from the English catalog.
export default {
  // ---- szybkie akcje: nazwy ----
  'prompts.action.improve.name': 'Popraw',
  'prompts.action.rewrite.name': 'Przeredaguj',
  'prompts.action.grammar.name': 'Skoryguj',
  'prompts.action.shorten.name': 'Skróć',
  'prompts.action.expand.name': 'Rozbuduj',
  'prompts.action.formal.name': 'Bardziej formalnie',
  'prompts.action.casual.name': 'Mniej formalnie',
  'prompts.action.personalize.name': 'Spersonalizuj',
  'prompts.action.summarize.name': 'Podsumuj',
  'prompts.action.explain.name': 'Wyjaśnij',
  'prompts.action.reply.name': 'Napisz odpowiedź',
  'prompts.action.translate.name': 'Przetłumacz',
  'prompts.error.unknownAction': 'Nieznana szybka akcja.',

  // ---- persony ----
  'prompts.persona.default.name': 'Domyślna',
  'prompts.persona.coder.name': 'Programista',
  'prompts.persona.translator.name': 'Tłumacz',
  'prompts.persona.editor.name': 'Redaktor',
  'prompts.persona.researcher.name': 'Badacz',
  'prompts.persona.teacher.name': 'Nauczyciel',

  // ---- podpowiedzi na ekranie powitalnym ----
  'prompts.suggestion.summarize.label': 'Podsumuj stronę',
  'prompts.suggestion.keyPoints.label': 'Najważniejsze punkty',
  'prompts.suggestion.explainSimply.label': 'Wyjaśnij prosto',
  'prompts.suggestion.review.label': 'Krytyczna ocena',
  'prompts.suggestion.translatePage.label': 'Przetłumacz stronę',
  'prompts.suggestion.image.label': 'Wygeneruj obraz',

  // ---- bloki kontekstu ----
  'prompts.pageContext.title': 'Tytuł: {value}',
  'prompts.videoContext.title': 'Tytuł: {value}',

  // ---- ustawienia (src/lib/settings.js) ----
  'core.settings.fallback.actionName': 'Akcja',
  'core.settings.fallback.personaName': 'Persona',
  'core.settings.import.empty': 'Plik jest pusty.',
  'core.settings.import.invalidJson': 'Plik nie zawiera prawidłowego JSON.',
  'core.settings.import.chatExport': 'Ten plik nie zawiera ustawień (może to eksport czatów?).',
  'core.settings.import.noSettings': 'Nieprawidłowy format: nie znaleziono ustawień.',
  'core.settings.import.notSidebarSettings': 'Plik nie zawiera ustawień LLM Sidebar.',
  'core.settings.import.providersNotList': 'Nieprawidłowy format: „providers” musi być listą.',
};
