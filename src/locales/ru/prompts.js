// ru: names and labels of the default quick actions, personas and welcome chips, plus the messages
// of src/lib/settings.js (core.settings.*).
// Only names and labels: the default prompt texts come from the English catalog.
export default {
  // ---- quick actions: names (UI) ----
  'prompts.action.improve.name': 'Улучшить',
  'prompts.action.rewrite.name': 'Переписать',
  'prompts.action.grammar.name': 'Исправить',
  'prompts.action.shorten.name': 'Сократить',
  'prompts.action.expand.name': 'Расширить',
  'prompts.action.formal.name': 'Более формально',
  'prompts.action.casual.name': 'Более неформально',
  'prompts.action.personalize.name': 'Персонализировать',
  'prompts.action.summarize.name': 'Кратко изложить',
  'prompts.action.explain.name': 'Объяснить',
  'prompts.action.reply.name': 'Черновик ответа',
  'prompts.action.translate.name': 'Перевести',
  'prompts.error.unknownAction': 'Неизвестное быстрое действие.',

  // ---- personas ----
  'prompts.persona.default.name': 'По умолчанию',
  'prompts.persona.coder.name': 'Разработчик',
  'prompts.persona.translator.name': 'Переводчик',
  'prompts.persona.editor.name': 'Редактор',
  'prompts.persona.researcher.name': 'Исследователь',
  'prompts.persona.teacher.name': 'Учитель',

  // ---- context blocks (labels)
  'prompts.pageContext.title': 'Заголовок: {value}',
  'prompts.videoContext.title': 'Название: {value}',

  // ---- side panel welcome chips ----
  'prompts.suggestion.summarize.label': 'Кратко изложить страницу',
  'prompts.suggestion.keyPoints.label': 'Главное',
  'prompts.suggestion.explainSimply.label': 'Объяснить просто',
  'prompts.suggestion.review.label': 'Критический разбор',
  'prompts.suggestion.translatePage.label': 'Перевести страницу',
  'prompts.suggestion.image.label': 'Создать изображение',

  // ---- settings (src/lib/settings.js) ----
  'core.settings.fallback.actionName': 'Действие',
  'core.settings.fallback.personaName': 'Персона',
  'core.settings.import.empty': 'Файл пуст.',
  'core.settings.import.invalidJson': 'Файл не содержит корректный JSON.',
  'core.settings.import.chatExport': 'В этом файле нет настроек (возможно, это экспорт чатов?).',
  'core.settings.import.noSettings': 'Недопустимый формат: настройки не найдены.',
  'core.settings.import.notSidebarSettings': 'В файле нет настроек LLM Sidebar.',
  'core.settings.import.providersNotList': 'Недопустимый формат: «providers» должно быть списком.',
};
