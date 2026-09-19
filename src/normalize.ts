/**
 * Speech to record values.
 *
 * STT hands us spoken forms: a DNI as spaced digits, a phone with a country code, an
 * email dictated as "ana dot garcia at gmail dot com". The clinic compares the record's
 * own normalized form, so every value entering the scratchpad goes through here — and
 * the normalized value is what the agent reads back, not what it heard.
 */

/** The check letter is derived from the digits, so a mishear is detectable on the call. */
const CHECK_LETTERS = 'TRWAGMYFPDXBNJZSQVHLCKE';
const NIE_PREFIX: Record<string, string> = { X: '0', Y: '1', Z: '2' };

/** Spoken letters STT writes as words. "b for burro" is out of scope; the spelling is. */
const SPOKEN_LETTERS: Record<string, string> = {
  alpha: 'A', bravo: 'B', charlie: 'C', delta: 'D', echo: 'E', foxtrot: 'F', golf: 'G',
  hotel: 'H', india: 'I', juliet: 'J', kilo: 'K', lima: 'L', mike: 'M', november: 'N',
  oscar: 'O', papa: 'P', quebec: 'Q', romeo: 'R', sierra: 'S', tango: 'T', uniform: 'U',
  victor: 'V', whiskey: 'W', xray: 'X', yankee: 'Y', zulu: 'Z',
};

const SPOKEN_DIGITS: Record<string, string> = {
  zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4', five: '5',
  six: '6', seven: '7', eight: '8', nine: '9',
};

export interface Normalized {
  value: string;
  /** Present when the value cannot be trusted; the agent should re-ask rather than record. */
  problem?: string;
}

/**
 * DNI (8 digits + letter) or NIE (X/Y/Z + 7 digits + letter), with the check letter
 * re-derived. A letter that disagrees with the digits is reported rather than silently
 * corrected: one of the two was misheard and only the caller knows which.
 */
export function normalizeNationalId(spoken: string): Normalized {
  const raw = collapseSpokenCharacters(spoken).replace(/[\s.\-/]/g, '').toUpperCase();
  const dni = /^(\d{8})([A-Z])$/.exec(raw);
  const nie = /^([XYZ])(\d{7})([A-Z])$/.exec(raw);
  if (!dni && !nie) {
    const digitsOnly = /^[XYZ]?\d{7,8}$/.test(raw);
    return { value: raw, problem: digitsOnly ? 'missing the check letter' : 'not a DNI or NIE' };
  }

  const digits = dni ? dni[1]! : `${NIE_PREFIX[nie![1]!]!}${nie![2]!}`;
  const stated = dni ? dni[2]! : nie![3]!;
  const expected = CHECK_LETTERS[Number(digits) % 23]!;
  return stated === expected
    ? { value: raw }
    : { value: raw, problem: `check letter should be ${expected} for those digits, not ${stated}` };
}

/**
 * Folded to the nine national digits, which is what the directory compares — so
 * `+34612345678`, `0034612345678` and the raw `from_number` are one query.
 */
export function normalizePhone(spoken: string): Normalized {
  const digits = collapseSpokenCharacters(spoken).replace(/\D/g, '').replace(/^(?:0034|34)(?=\d{9}$)/, '');
  return digits.length === 9
    ? { value: digits }
    : { value: digits, problem: `${digits.length} digits, expected 9` };
}

/** "ana dot garcia at gmail dot com" — dictated, with no check letter to catch a mishear. */
export function normalizeEmail(spoken: string): Normalized {
  const value = collapseSpokenCharacters(spoken)
    .toLowerCase()
    .replace(/\s*\b(?:at|arroba)\b\s*/g, '@')
    .replace(/\s*\b(?:dot|point|punto)\b\s*/g, '.')
    .replace(/\s*\b(?:underscore|guion bajo)\b\s*/g, '_')
    .replace(/\s*\b(?:dash|hyphen|guion)\b\s*/g, '-')
    .replace(/\s+/g, '')
    .replace(/[,;]/g, '');
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value) ? { value } : { value, problem: 'not an email address' };
}

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

const ORDINALS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8,
  ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14,
  fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19,
  twentieth: 20, 'twenty-first': 21, 'twenty-second': 22, 'twenty-third': 23,
  'twenty-fourth': 24, 'twenty-fifth': 25, 'twenty-sixth': 26, 'twenty-seventh': 27,
  'twenty-eighth': 28, 'twenty-ninth': 29, thirtieth: 30, 'thirty-first': 31,
};

/** ISO through untouched; "the fourteenth of March 1985" and "14 March 1985" resolved. */
export function normalizeDate(spoken: string): Normalized {
  const text = spoken.trim().toLowerCase();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (iso) return isRealDate(text) ? { value: text } : { value: text, problem: 'not a real date' };

  const month = MONTHS.findIndex((m) => text.includes(m));
  const year = /\b(1\d{3}|20\d{2})\b/.exec(text)?.[1];
  const dayWord = Object.keys(ORDINALS).find((w) => new RegExp(`\\b${w}\\b`).test(text));
  const dayNumber = /\b(\d{1,2})(?:st|nd|rd|th)?\b(?!\d)/.exec(text.replace(year ?? '', ''))?.[1];
  const day = dayWord ? ORDINALS[dayWord]! : dayNumber ? Number(dayNumber) : NaN;

  if (month === -1 || !year || !Number.isFinite(day)) {
    return { value: spoken.trim(), problem: 'could not read a date out of that' };
  }
  const value = `${year}-${pad(month + 1)}-${pad(day)}`;
  return isRealDate(value) ? { value } : { value, problem: 'not a real date' };
}

/** Two surnames, Spanish-style, and the spelling wins over how it first sounded. */
export function normalizeName(spoken: string): Normalized {
  const value = collapseSpokenCharacters(spoken)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,]$/, '');
  return value.length > 0 ? { value } : { value, problem: 'empty' };
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function isRealDate(iso: string): boolean {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/**
 * Digits and letters dictated one at a time come back as separate tokens — "4 8 0 6" or
 * "b, e, r, n, a". Runs of single characters are joined; ordinary words are left alone.
 */
function collapseSpokenCharacters(spoken: string): string {
  const tokens = spoken.trim().split(/[\s,]+/).filter(Boolean);
  const out: string[] = [];
  let run: string[] = [];

  const flush = (): void => {
    if (run.length >= 2) out.push(run.join(''));
    else out.push(...run);
    run = [];
  };

  for (const token of tokens) {
    const word = token.toLowerCase().replace(/[.]$/, '');
    const single = SPOKEN_DIGITS[word] ?? SPOKEN_LETTERS[word] ?? (/^[a-z0-9]$/i.test(token) ? token : null);
    if (single !== null) run.push(single);
    else {
      flush();
      out.push(token);
    }
  }
  flush();
  return out.join(' ');
}
