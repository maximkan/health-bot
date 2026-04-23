const CAFFEINE_MAP = [
  { re: /double espresso|doppio/i,                                          mg: 126 },
  { re: /espresso/i,                                                         mg: 63  },
  { re: /coffee|americano|latte|cappuccino|flat white|long black|nescafe/i, mg: 95  },
  { re: /energy drink|monster|red bull/i,                                   mg: 80  },
  { re: /green tea|matcha/i,                                                 mg: 47  },
  { re: /teh|tea/i,                                                          mg: 25  },
  { re: /milo/i,                                                             mg: 10  },
];

function estimateCaffeine(name = '') {
  for (const { re, mg } of CAFFEINE_MAP) {
    if (re.test(name)) return mg;
  }
  return 0;
}

module.exports = { estimateCaffeine };
