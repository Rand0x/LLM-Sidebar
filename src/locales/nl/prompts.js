// nl: standaard snelle acties, persona’s en instellingsmeldingen (src/lib/prompts.js, src/lib/settings.js).
// Alleen namen en labels: de standaardprompts komen uit de Engelse catalogus.
export default {
  // ---- snelle acties: namen ----
  'prompts.action.improve.name': 'Verbeteren',
  'prompts.action.rewrite.name': 'Herschrijven',
  'prompts.action.grammar.name': 'Corrigeren',
  'prompts.action.shorten.name': 'Inkorten',
  'prompts.action.expand.name': 'Uitbreiden',
  'prompts.action.formal.name': 'Formeler',
  'prompts.action.casual.name': 'Informeler',
  'prompts.action.personalize.name': 'Personaliseren',
  'prompts.action.summarize.name': 'Samenvatten',
  'prompts.action.explain.name': 'Uitleggen',
  'prompts.action.reply.name': 'Antwoord opstellen',
  'prompts.action.translate.name': 'Vertalen',
  'prompts.error.unknownAction': 'Onbekende snelle actie.',

  // ---- persona’s ----
  'prompts.persona.default.name': 'Standaard',
  'prompts.persona.coder.name': 'Ontwikkelaar',
  'prompts.persona.translator.name': 'Vertaler',
  'prompts.persona.editor.name': 'Redacteur',
  'prompts.persona.researcher.name': 'Onderzoek',
  'prompts.persona.teacher.name': 'Leraar',

  // ---- suggesties op het welkomstscherm ----
  'prompts.suggestion.summarize.label': 'Pagina samenvatten',
  'prompts.suggestion.keyPoints.label': 'Belangrijkste punten',
  'prompts.suggestion.explainSimply.label': 'Eenvoudig uitleggen',
  'prompts.suggestion.review.label': 'Kritische beoordeling',
  'prompts.suggestion.translatePage.label': 'Pagina vertalen',
  'prompts.suggestion.image.label': 'Afbeelding genereren',

  // ---- contextblokken ----
  'prompts.pageContext.title': 'Titel: {value}',
  'prompts.videoContext.title': 'Titel: {value}',

  // ---- instellingen (src/lib/settings.js) ----
  'core.settings.fallback.actionName': 'Actie',
  'core.settings.fallback.personaName': 'Persona',
  'core.settings.import.empty': 'Het bestand is leeg.',
  'core.settings.import.invalidJson': 'Het bestand bevat geen geldige JSON.',
  'core.settings.import.chatExport': 'Dit bestand bevat geen instellingen (misschien is het een chatexport?).',
  'core.settings.import.noSettings': 'Ongeldig formaat: er zijn geen instellingen gevonden.',
  'core.settings.import.notSidebarSettings': 'Het bestand bevat geen instellingen van LLM Sidebar.',
  'core.settings.import.providersNotList': 'Ongeldig formaat: “providers” moet een lijst zijn.',
};
