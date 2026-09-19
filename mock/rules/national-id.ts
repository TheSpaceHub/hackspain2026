/**
 * Spanish national ids. A DNI is eight digits and a check letter; an NIE swaps the
 * first digit for X, Y or Z. The letter is derived from the number, which is what
 * lets the API tell a misheard digit from an invented id.
 */

const LETTERS = 'TRWAGMYFPDXBNJZSQVHLCKE';
const NIE_PREFIX: Record<string, string> = { X: '0', Y: '1', Z: '2' };

/** Upper-case, no spaces, dots or dashes — the way the id is compared. */
export function normaliseNationalId(raw: string): string {
  return raw.toUpperCase().replace(/[\s.\-]/g, '');
}

export function checkLetter(digits: string): string {
  return LETTERS[Number(digits) % 23]!;
}

/** Null when the id is well-formed and its letter matches; otherwise why not. */
export function nationalIdProblem(raw: string): string | null {
  const id = normaliseNationalId(raw);
  const m = /^([XYZ]?)(\d{7,8})([A-Z])$/.exec(id);
  if (!m) return `not a DNI or NIE: '${raw}'`;
  const [, prefix, digits, letter] = m;
  const number = prefix ? `${NIE_PREFIX[prefix]}${digits}` : digits!;
  if (prefix ? digits!.length !== 7 : digits!.length !== 8) return `not a DNI or NIE: '${raw}'`;
  return checkLetter(number) === letter ? null : `check letter does not match its number: '${raw}'`;
}

export function makeDni(digits: string): string {
  return `${digits}${checkLetter(digits)}`;
}

export function makeNie(prefix: 'X' | 'Y' | 'Z', digits7: string): string {
  return `${prefix}${digits7}${checkLetter(`${NIE_PREFIX[prefix]}${digits7}`)}`;
}
