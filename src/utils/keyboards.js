// Inline-keyboard markups for confirmation flows. callback_data is `<kind>:<action>`;
// the callback handler reads the user's (DB-backed) pending state and performs the action,
// so a button still works even across a process restart. Typed replies keep working too.
module.exports = {
  MEAL_PREVIEW_KB: { reply_markup: { inline_keyboard: [[
    { text: '✅ Log',    callback_data: 'mc:log' },
    { text: '✏️ Edit',   callback_data: 'mc:edit' },
    { text: '❌ Cancel', callback_data: 'mc:cancel' },
  ]]}},
  WORKOUT_PREVIEW_KB: { reply_markup: { inline_keyboard: [[
    { text: '✅ Log',    callback_data: 'wc:log' },
    { text: '✏️ Edit',   callback_data: 'wc:edit' },
    { text: '❌ Cancel', callback_data: 'wc:cancel' },
  ]]}},
  LIVE_WORKOUT_KB: { reply_markup: { inline_keyboard: [[
    { text: '🏁 Finished', callback_data: 'lw:finish' },
  ]]}},
  // Golf — context-aware. Type (when unknown), then the relevant sub-question only.
  GOLF_TYPE_KB: { reply_markup: { inline_keyboard: [
    [{ text: '⛳ Course', callback_data: 'gt:course' }, { text: '🎯 Range', callback_data: 'gt:range' }, { text: '🖥 Simulator', callback_data: 'gt:sim' }],
    [{ text: '✅ Log', callback_data: 'wc:log' }, { text: '❌ Cancel', callback_data: 'wc:cancel' }],
  ]}},
  GOLF_COURSE_KB: { reply_markup: { inline_keyboard: [
    [{ text: '🚶 Walking', callback_data: 'gv:walking' }, { text: '🛺 Cart', callback_data: 'gv:cart' }],
    [{ text: '✅ Log', callback_data: 'wc:log' }, { text: '✏️ Edit', callback_data: 'wc:edit' }, { text: '❌ Cancel', callback_data: 'wc:cancel' }],
  ]}},
  GOLF_RANGE_KB: { reply_markup: { inline_keyboard: [
    [{ text: '😌 Light', callback_data: 'gi:light' }, { text: '💪 Moderate', callback_data: 'gi:moderate' }, { text: '🔥 Hard', callback_data: 'gi:hard' }],
    [{ text: '✅ Log', callback_data: 'wc:log' }, { text: '✏️ Edit', callback_data: 'wc:edit' }, { text: '❌ Cancel', callback_data: 'wc:cancel' }],
  ]}},
};
