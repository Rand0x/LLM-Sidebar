// tr: names and labels of the default quick actions, personas and welcome chips, plus the messages
// of src/lib/settings.js (core.settings.*).
// Only names and labels: the default prompt texts come from the English catalog.
export default {
  // ---- quick actions: names (UI) ----
  'prompts.action.improve.name': 'İyileştir',
  'prompts.action.rewrite.name': 'Yeniden yaz',
  'prompts.action.grammar.name': 'Düzelt',
  'prompts.action.shorten.name': 'Kısalt',
  'prompts.action.expand.name': 'Genişlet',
  'prompts.action.formal.name': 'Daha resmî',
  'prompts.action.casual.name': 'Daha samimi',
  'prompts.action.personalize.name': 'Kişiselleştir',
  'prompts.action.summarize.name': 'Özetle',
  'prompts.action.explain.name': 'Açıkla',
  'prompts.action.reply.name': 'Yanıt taslağı',
  'prompts.action.translate.name': 'Çevir',
  'prompts.error.unknownAction': 'Bilinmeyen hızlı eylem.',

  // ---- personas ----
  'prompts.persona.default.name': 'Varsayılan',
  'prompts.persona.coder.name': 'Yazılımcı',
  'prompts.persona.translator.name': 'Çevirmen',
  'prompts.persona.editor.name': 'Editör',
  'prompts.persona.researcher.name': 'Araştırma',
  'prompts.persona.teacher.name': 'Öğretmen',

  // ---- context blocks (labels)
  'prompts.pageContext.title': 'Başlık: {value}',
  'prompts.videoContext.title': 'Başlık: {value}',

  // ---- side panel welcome chips ----
  'prompts.suggestion.summarize.label': 'Sayfayı özetle',
  'prompts.suggestion.keyPoints.label': 'Ana noktalar',
  'prompts.suggestion.explainSimply.label': 'Basitçe açıkla',
  'prompts.suggestion.review.label': 'Eleştirel inceleme',
  'prompts.suggestion.translatePage.label': 'Sayfayı çevir',
  'prompts.suggestion.image.label': 'Görsel üret',

  // ---- settings (src/lib/settings.js) ----
  'core.settings.fallback.actionName': 'Eylem',
  'core.settings.fallback.personaName': 'Persona',
  'core.settings.import.empty': 'Dosya boş.',
  'core.settings.import.invalidJson': 'Dosya geçerli JSON içermiyor.',
  'core.settings.import.chatExport': 'Bu dosya hiçbir ayar içermiyor (belki bir sohbet dışa aktarımıdır?).',
  'core.settings.import.noSettings': 'Geçersiz biçim: ayar bulunamadı.',
  'core.settings.import.notSidebarSettings': 'Dosya hiçbir LLM Sidebar ayarı içermiyor.',
  'core.settings.import.providersNotList': 'Geçersiz biçim: “providers” bir liste olmalıdır.',
};
