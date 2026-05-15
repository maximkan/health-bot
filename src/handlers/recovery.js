const claude = require('../claude');
const db     = require('../db');

async function handleRecovery(bot, msg) {
  const chatId = msg.chat.id;
  await bot.sendChatAction(chatId, 'typing');
  try {
    const state    = db.getState(chatId);
    const dayStart = state.current_day_start;
    const protocols = await claude.parseRecovery(msg.text || msg.caption || '');

    if (!protocols.length) {
      await bot.sendMessage(chatId, '❌ Couldn\'t parse. Try: "3 rounds sauna 10min 100°C + cold plunge 3min 8°C" or "sauna 20min 85°C"');
      return;
    }

    const lines = [];
    for (const proto of protocols) {
      const protocolId = proto.protocol === 'contrast' ? `${Date.now()}` : null;
      const retro = msg._retroDate?.dateStr ? ` (${msg._retroDate.dateStr})` : '';

      if (proto.protocol === 'contrast' && proto.uniform === false) {
        // Per-round contrast: each step in each round is its own row
        for (const round of proto.rounds) {
          for (const s of round.steps) {
            const row = {
              type: s.type,
              rounds: 1,
              duration_per_round_min: s.duration_min,
              total_duration_min: s.duration_min,
              temperature_c: s.temperature_c,
              protocol: 'contrast',
              protocol_id: protocolId,
              sequence_order: s.sequence_order,
              round_number: round.round_number,
            };
            if (msg._retroDate?.dateStr) row.date = msg._retroDate.dateStr;
            db.saveRecoveryLog(chatId, row, dayStart);
          }
        }
        const totalRounds = proto.rounds.length;
        const roundStrs = proto.rounds.map(r => {
          const steps = r.steps
            .sort((a, b) => a.sequence_order - b.sequence_order)
            .map(s => `${s.type.toLowerCase()}${s.temperature_c ? ` ${s.temperature_c}°C` : ''} ${s.duration_min}min`)
            .join('→');
          return `R${r.round_number}: ${steps}`;
        });
        lines.push(`✅ Contrast therapy — ${totalRounds} rounds (variable):\n  ${roundStrs.join('\n  ')}${retro}`);

      } else if (proto.protocol === 'contrast') {
        // Uniform contrast: one set of sessions repeated N times
        const { rounds, sessions } = proto;
        for (const s of sessions) {
          const totalMin = rounds * s.duration_min;
          const row = {
            type: s.type,
            rounds,
            duration_per_round_min: s.duration_min,
            total_duration_min: totalMin,
            temperature_c: s.temperature_c,
            protocol: 'contrast',
            protocol_id: protocolId,
            sequence_order: s.sequence_order,
            round_number: null,
          };
          if (msg._retroDate?.dateStr) row.date = msg._retroDate.dateStr;
          db.saveRecoveryLog(chatId, row, dayStart);
        }
        const parts = sessions
          .sort((a, b) => a.sequence_order - b.sequence_order)
          .map(s => `${s.type.toLowerCase()}${s.temperature_c ? ` ${s.temperature_c}°C` : ''} ${s.duration_min}min`)
          .join(' → ');
        lines.push(`✅ Contrast therapy — ${rounds} rounds of ${parts}${retro}`);

      } else {
        // Single sessions
        const { sessions } = proto;
        for (const s of sessions) {
          const row = {
            type: s.type,
            rounds: 1,
            duration_per_round_min: s.duration_min,
            total_duration_min: s.duration_min,
            temperature_c: s.temperature_c,
            protocol: 'single',
            protocol_id: null,
            sequence_order: s.sequence_order,
            round_number: null,
          };
          if (msg._retroDate?.dateStr) row.date = msg._retroDate.dateStr;
          db.saveRecoveryLog(chatId, row, dayStart);
          const tempStr = s.temperature_c != null ? ` @ ${s.temperature_c}°C` : '';
          lines.push(`✅ ${s.type} — ${s.duration_min}min${tempStr}${retro}`);
        }
      }
    }

    await bot.sendMessage(chatId, lines.join('\n'));
  } catch (err) {
    console.error('Recovery error:', err.message, err.stack);
    await bot.sendMessage(chatId, `❌ ${err.message}`);
  }
}

module.exports = { handleRecovery };
