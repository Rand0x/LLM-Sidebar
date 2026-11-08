// Only names and labels: the default prompt texts come from the English catalog.
export default {
  // ---- quick actions: names (UI) ----
  'prompts.action.improve.name': 'Melhorar',
  'prompts.action.rewrite.name': 'Reescrever',
  'prompts.action.grammar.name': 'Corrigir',
  'prompts.action.shorten.name': 'Encurtar',
  'prompts.action.expand.name': 'Expandir',
  'prompts.action.formal.name': 'Mais formal',
  'prompts.action.casual.name': 'Mais informal',
  'prompts.action.personalize.name': 'Personalizar',
  'prompts.action.summarize.name': 'Resumir',
  'prompts.action.explain.name': 'Explicar',
  'prompts.action.reply.name': 'Redigir resposta',
  'prompts.action.translate.name': 'Traduzir',
  'prompts.error.unknownAction': 'Ação rápida desconhecida.',
  // ---- personas ----
  'prompts.persona.default.name': 'Padrão',
  'prompts.persona.coder.name': 'Desenvolvedor',
  'prompts.persona.translator.name': 'Tradutor',
  'prompts.persona.editor.name': 'Editor',
  'prompts.persona.researcher.name': 'Pesquisa',
  'prompts.persona.teacher.name': 'Professor',
  // ---- context blocks ----
  'prompts.pageContext.title': 'Título: {value}',
  'prompts.videoContext.title': 'Título: {value}',
  // ---- side panel welcome chips ----
  'prompts.suggestion.summarize.label': 'Resumir página',
  'prompts.suggestion.keyPoints.label': 'Pontos principais',
  'prompts.suggestion.explainSimply.label': 'Explicar de forma simples',
  'prompts.suggestion.review.label': 'Análise crítica',
  'prompts.suggestion.translatePage.label': 'Traduzir página',
  'prompts.suggestion.image.label': 'Gerar imagem',
  // ---- settings (src/lib/settings.js) ----
  'core.settings.fallback.actionName': 'Ação',
  'core.settings.fallback.personaName': 'Persona',
  'core.settings.import.empty': 'O arquivo está vazio.',
  'core.settings.import.invalidJson': 'O arquivo não contém JSON válido.',
  'core.settings.import.chatExport': 'Este arquivo não contém nenhuma configuração (talvez seja uma exportação de chats?).',
  'core.settings.import.noSettings': 'Formato inválido: nenhuma configuração foi encontrada.',
  'core.settings.import.notSidebarSettings': 'O arquivo não contém nenhuma configuração do LLM Sidebar.',
  'core.settings.import.providersNotList': 'Formato inválido: “providers” deve ser uma lista.',
};
