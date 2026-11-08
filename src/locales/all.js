// Registers every UI catalog statically. Used by the background script, where dynamic import()
// is not available (Chrome service worker). Extension pages load only the catalog they need.
import { registerCatalog } from '../lib/i18n.js';
import de from './de/index.js';
import en from './en/index.js';
import es from './es/index.js';
import fr from './fr/index.js';
import it from './it/index.js';
import ptBR from './pt-BR/index.js';
import nl from './nl/index.js';
import pl from './pl/index.js';
import tr from './tr/index.js';
import ru from './ru/index.js';
import ja from './ja/index.js';
import zhCN from './zh-CN/index.js';

registerCatalog('de', de);
registerCatalog('en', en);
registerCatalog('es', es);
registerCatalog('fr', fr);
registerCatalog('it', it);
registerCatalog('pt-BR', ptBR);
registerCatalog('nl', nl);
registerCatalog('pl', pl);
registerCatalog('tr', tr);
registerCatalog('ru', ru);
registerCatalog('ja', ja);
registerCatalog('zh-CN', zhCN);
