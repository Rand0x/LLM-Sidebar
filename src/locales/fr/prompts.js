// fr: Only names and labels: the default prompt texts come from the English catalog.
export default {
  // ---- quick actions: names (UI) ----
  'prompts.action.improve.name': 'Améliorer',
  'prompts.action.rewrite.name': 'Reformuler',
  'prompts.action.grammar.name': 'Corriger',
  'prompts.action.shorten.name': 'Raccourcir',
  'prompts.action.expand.name': 'Développer',
  'prompts.action.formal.name': 'Plus formel',
  'prompts.action.casual.name': 'Plus décontracté',
  'prompts.action.personalize.name': 'Personnaliser',
  'prompts.action.summarize.name': 'Résumer',
  'prompts.action.explain.name': 'Expliquer',
  'prompts.action.reply.name': 'Rédiger une réponse',
  'prompts.action.translate.name': 'Traduire',

  // ---- quick actions: request building ----
  'prompts.error.unknownAction': 'Action rapide inconnue.',

  // ---- personas ----
  'prompts.persona.default.name': 'Par défaut',
  'prompts.persona.coder.name': 'Développeur',
  'prompts.persona.translator.name': 'Traducteur',
  'prompts.persona.editor.name': 'Relecteur',
  'prompts.persona.researcher.name': 'Recherche',
  'prompts.persona.teacher.name': 'Enseignant',

  // ---- side panel welcome chips ----
  'prompts.suggestion.summarize.label': 'Résumer la page',
  'prompts.suggestion.keyPoints.label': 'Points clés',
  'prompts.suggestion.explainSimply.label': 'Expliquer simplement',
  'prompts.suggestion.review.label': 'Analyse critique',
  'prompts.suggestion.translatePage.label': 'Traduire la page',
  'prompts.suggestion.image.label': 'Générer une image',

  // ---- context blocks ----
  'prompts.pageContext.title': 'Titre : {value}',
  'prompts.videoContext.title': 'Titre : {value}',

  // ---- settings (src/lib/settings.js) ----
  'core.settings.fallback.actionName': 'Action',
  'core.settings.fallback.personaName': 'Persona',
  'core.settings.import.empty': 'Le fichier est vide.',
  'core.settings.import.invalidJson': 'Le fichier ne contient pas de JSON valide.',
  'core.settings.import.chatExport': 'Ce fichier ne contient aucun paramètre (peut-être s’agit-il d’une exportation de discussions ?).',
  'core.settings.import.noSettings': 'Format non valide : aucun paramètre trouvé.',
  'core.settings.import.notSidebarSettings': 'Le fichier ne contient aucun paramètre de LLM Sidebar.',
  'core.settings.import.providersNotList': 'Format non valide : « providers » doit être une liste.',
};
