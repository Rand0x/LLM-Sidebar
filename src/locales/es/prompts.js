// Only names and labels: the default prompt texts come from the English catalog.
export default {
  // ---- quick actions: names (UI) ----
  'prompts.action.improve.name': 'Mejorar',
  'prompts.action.rewrite.name': 'Reformular',
  'prompts.action.grammar.name': 'Corregir',
  'prompts.action.shorten.name': 'Acortar',
  'prompts.action.expand.name': 'Ampliar',
  'prompts.action.formal.name': 'Más formal',
  'prompts.action.casual.name': 'Más informal',
  'prompts.action.personalize.name': 'Personalizar',
  'prompts.action.summarize.name': 'Resumir',
  'prompts.action.explain.name': 'Explicar',
  'prompts.action.reply.name': 'Redactar respuesta',
  'prompts.action.translate.name': 'Traducir',
  'prompts.error.unknownAction': 'Acción rápida desconocida.',
  // ---- personas ----
  'prompts.persona.default.name': 'Predeterminado',
  'prompts.persona.coder.name': 'Desarrollador',
  'prompts.persona.translator.name': 'Traductor',
  'prompts.persona.editor.name': 'Editor',
  'prompts.persona.researcher.name': 'Investigación',
  'prompts.persona.teacher.name': 'Profesor',
  // ---- context blocks ----
  'prompts.pageContext.title': 'Título: {value}',
  'prompts.videoContext.title': 'Título: {value}',
  // ---- side panel welcome chips ----
  'prompts.suggestion.summarize.label': 'Resumir página',
  'prompts.suggestion.keyPoints.label': 'Puntos clave',
  'prompts.suggestion.explainSimply.label': 'Explícamelo fácil',
  'prompts.suggestion.review.label': 'Revisión crítica',
  'prompts.suggestion.translatePage.label': 'Traducir página',
  'prompts.suggestion.image.label': 'Generar imagen',
  // ---- settings (src/lib/settings.js) ----
  'core.settings.fallback.actionName': 'Acción',
  'core.settings.fallback.personaName': 'Rol',
  'core.settings.import.empty': 'El archivo está vacío.',
  'core.settings.import.invalidJson': 'El archivo no contiene JSON válido.',
  'core.settings.import.chatExport': 'Este archivo no contiene ninguna configuración (¿quizá sea una exportación de chats?).',
  'core.settings.import.noSettings': 'Formato no válido: no se encontró ninguna configuración.',
  'core.settings.import.notSidebarSettings': 'El archivo no contiene ninguna configuración de LLM Sidebar.',
  'core.settings.import.providersNotList': 'Formato no válido: “providers” debe ser una lista.',
};
