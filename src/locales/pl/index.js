// pl: UI messages, merged from one file per area (see src/lib/i18n.js).
import common from './common.js';
import core from './core.js';
import prompts from './prompts.js';
import sidepanel from './sidepanel.js';
import options from './options.js';
import optionsSections from './options-sections.js';
import content from './content.js';

export default {
  ...common,
  ...core,
  ...prompts,
  ...sidepanel,
  ...options,
  ...optionsSections,
  ...content,
};
