// Only names and labels: the default prompt texts come from the English catalog.
export default {
  // ---- quick actions: names (UI) ----
  'prompts.action.improve.name': '优化',
  'prompts.action.rewrite.name': '改写',
  'prompts.action.grammar.name': '纠错',
  'prompts.action.shorten.name': '精简',
  'prompts.action.expand.name': '扩写',
  'prompts.action.formal.name': '更正式',
  'prompts.action.casual.name': '更随意',
  'prompts.action.personalize.name': '个性化',
  'prompts.action.summarize.name': '总结',
  'prompts.action.explain.name': '解释',
  'prompts.action.reply.name': '起草回复',
  'prompts.action.translate.name': '翻译',

  // ---- quick actions: request building ----
  'prompts.error.unknownAction': '未知的快捷操作。',

  // ---- personas ----
  'prompts.persona.default.name': '默认',
  'prompts.persona.coder.name': '开发者',
  'prompts.persona.translator.name': '翻译',
  'prompts.persona.editor.name': '编辑',
  'prompts.persona.researcher.name': '研究',
  'prompts.persona.teacher.name': '老师',

  // ---- side panel welcome chips ----
  'prompts.suggestion.summarize.label': '总结网页',
  'prompts.suggestion.keyPoints.label': '要点',
  'prompts.suggestion.explainSimply.label': '通俗解释',
  'prompts.suggestion.review.label': '批判性评议',
  'prompts.suggestion.translatePage.label': '翻译网页',
  'prompts.suggestion.image.label': '生成图片',

  // ---- context blocks ----
  'prompts.pageContext.title': '标题：{value}',
  'prompts.videoContext.title': '标题：{value}',

  // ---- settings (src/lib/settings.js) ----
  'core.settings.fallback.actionName': '操作',
  'core.settings.fallback.personaName': '角色',
  'core.settings.import.empty': '文件为空。',
  'core.settings.import.invalidJson': '文件不包含有效的 JSON。',
  'core.settings.import.chatExport': '此文件不包含任何设置（可能是聊天导出文件？）。',
  'core.settings.import.noSettings': '格式无效：未找到设置。',
  'core.settings.import.notSidebarSettings': '此文件不包含 LLM Sidebar 的设置。',
  'core.settings.import.providersNotList': '格式无效：“providers”必须是列表。',
};
