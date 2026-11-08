// Only names and labels: the default prompt texts come from the English catalog.
export default {
  // ---- quick actions: names (UI) ----
  'prompts.action.improve.name': '改善',
  'prompts.action.rewrite.name': '書き直し',
  'prompts.action.grammar.name': '校正',
  'prompts.action.shorten.name': '短く',
  'prompts.action.expand.name': '詳しく',
  'prompts.action.formal.name': 'フォーマルに',
  'prompts.action.casual.name': 'カジュアルに',
  'prompts.action.personalize.name': '自分らしく',
  'prompts.action.summarize.name': '要約',
  'prompts.action.explain.name': '説明',
  'prompts.action.reply.name': '返信の下書き',
  'prompts.action.translate.name': '翻訳',

  // ---- quick actions: request building ----
  'prompts.error.unknownAction': '不明なクイックアクションです。',

  // ---- personas ----
  'prompts.persona.default.name': '標準',
  'prompts.persona.coder.name': '開発者',
  'prompts.persona.translator.name': '翻訳者',
  'prompts.persona.editor.name': '編集者',
  'prompts.persona.researcher.name': 'リサーチ',
  'prompts.persona.teacher.name': '先生',

  // ---- side panel welcome chips ----
  'prompts.suggestion.summarize.label': 'ページを要約',
  'prompts.suggestion.keyPoints.label': '要点',
  'prompts.suggestion.explainSimply.label': 'やさしく説明',
  'prompts.suggestion.review.label': '批評的レビュー',
  'prompts.suggestion.translatePage.label': 'ページを翻訳',
  'prompts.suggestion.image.label': '画像を生成',

  // ---- context blocks ----
  'prompts.pageContext.title': 'タイトル：{value}',
  'prompts.videoContext.title': 'タイトル：{value}',

  // ---- settings (src/lib/settings.js) ----
  'core.settings.fallback.actionName': 'アクション',
  'core.settings.fallback.personaName': 'ペルソナ',
  'core.settings.import.empty': 'ファイルが空です。',
  'core.settings.import.invalidJson': 'ファイルに有効な JSON が含まれていません。',
  'core.settings.import.chatExport': 'このファイルには設定が含まれていません（チャットのエクスポートファイルではありませんか？）。',
  'core.settings.import.noSettings': '形式が正しくありません。設定が見つかりませんでした。',
  'core.settings.import.notSidebarSettings': 'このファイルには LLM Sidebar の設定が含まれていません。',
  'core.settings.import.providersNotList': '形式が正しくありません。「providers」は一覧である必要があります。',
};
