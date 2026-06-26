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
  // Golf preview: pick how it was played (changes the MET), then log. Defaults to walking if they just log.
  GOLF_PREVIEW_KB: { reply_markup: { inline_keyboard: [
    [{ text: '🚶 Walking', callback_data: 'gv:walking' }, { text: '🛺 Cart', callback_data: 'gv:cart' }, { text: '🎯 Range', callback_data: 'gv:range' }],
    [{ text: '✅ Log', callback_data: 'wc:log' }, { text: '✏️ Edit', callback_data: 'wc:edit' }, { text: '❌ Cancel', callback_data: 'wc:cancel' }],
  ]}},
};
