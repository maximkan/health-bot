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
  const isoWeek = getISOWeek();
  const natural = isoWeek % 2 === 1 ? 'odd' : 'even';
  if (!fs.existsSync(CONFIG_FILE)) return natural;
  try {
    const { flip } = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return flip ? (natural === 'odd' ? 'even' : 'odd') : natural;
  } catch {
    return natural;
  }
}

function setWeekType(type) {
  const isoWeek = getISOWeek();
  const natural = isoWeek % 2 === 1 ? 'odd' : 'even';
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ flip: natural !== type }));
}

module.exports = { getCurrentWeekType, setWeekType };
