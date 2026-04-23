const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '../../data/week-config.json');

function getISOWeek() {
  // Use Malaysia time (UTC+8)
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

function getCurrentWeekType() {
  if (!fs.existsSync(CONFIG_FILE)) return null;
  try {
    const { anchorType, anchorWeek } = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    const diff = getISOWeek() - anchorWeek;
    return diff % 2 === 0 ? anchorType : (anchorType === 'odd' ? 'even' : 'odd');
  } catch {
    return null;
  }
}

function setWeekType(type) {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ anchorType: type, anchorWeek: getISOWeek() }));
}

module.exports = { getCurrentWeekType, setWeekType };
