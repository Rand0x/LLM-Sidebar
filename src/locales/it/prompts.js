// it: Only names and labels: the default prompt texts come from the English catalog.
export default {
  // ---- quick actions: names (UI) ----
  'prompts.action.improve.name': 'Migliora',
  'prompts.action.rewrite.name': 'Riscrivi',
  'prompts.action.grammar.name': 'Correggi',
  'prompts.action.shorten.name': 'Accorcia',
  'prompts.action.expand.name': 'Espandi',
  'prompts.action.formal.name': 'Più formale',
  'prompts.action.casual.name': 'Più informale',
  'prompts.action.personalize.name': 'Personalizza',
  'prompts.action.summarize.name': 'Riassumi',
  'prompts.action.explain.name': 'Spiega',
  'prompts.action.reply.name': 'Scrivi una risposta',
  'prompts.action.translate.name': 'Traduci',

  // ---- quick actions: request building ----
  'prompts.error.unknownAction': 'Azione rapida sconosciuta.',

  // ---- personas ----
  'prompts.persona.default.name': 'Predefinita',
  'prompts.persona.coder.name': 'Sviluppatore',
  'prompts.persona.translator.name': 'Traduttore',
  'prompts.persona.editor.name': 'Revisore',
  'prompts.persona.researcher.name': 'Ricerca',
  'prompts.persona.teacher.name': 'Insegnante',

  // ---- side panel welcome chips ----
  'prompts.suggestion.summarize.label': 'Riassumi la pagina',
  'prompts.suggestion.keyPoints.label': 'Punti chiave',
  'prompts.suggestion.explainSimply.label': 'Spiegalo in modo semplice',
  'prompts.suggestion.review.label': 'Analisi critica',
  'prompts.suggestion.translatePage.label': 'Traduci la pagina',
  'prompts.suggestion.image.label': 'Genera un’immagine',

  // ---- context blocks ----
  'prompts.pageContext.title': 'Titolo: {value}',
  'prompts.videoContext.title': 'Titolo: {value}',

  // ---- settings (src/lib/settings.js) ----
  'core.settings.fallback.actionName': 'Azione',
  'core.settings.fallback.personaName': 'Persona',
  'core.settings.import.empty': 'Il file è vuoto.',
  'core.settings.import.invalidJson': 'Il file non contiene JSON valido.',
  'core.settings.import.chatExport': 'Questo file non contiene nessuna impostazione (forse è un’esportazione di chat?).',
  'core.settings.import.noSettings': 'Formato non valido: nessuna impostazione trovata.',
  'core.settings.import.notSidebarSettings': 'Il file non contiene nessuna impostazione di LLM Sidebar.',
  'core.settings.import.providersNotList': 'Formato non valido: «providers» deve essere un elenco.',
};
