/**
 * Whether a board member's text holds a Swedish personal identity number
 * (personnummer) or coordination number (samordningsnummer).
 *
 * Text a board member types for an assistant goes to the model provider, and
 * the recipient the board consented to receives names, apartments, free text
 * and health, not identity numbers. So such text is refused before anything
 * is sent, as the platform refuses one in the free text it stores.
 *
 * A smaller copy of the platform's scanner, which this package cannot import:
 * ten or twelve digits, with a separator before the last four, that touch no
 * other digit; a real calendar day, or that day plus 60 for a coordination
 * number; and the Luhn check over the last ten. The day and the check digit
 * are what keep an amount or an invoice number from being taken for one. The
 * text is folded first, so a number in fullwidth digits or broken up by an
 * invisible character is still found.
 */

const CANDIDATE =
  /(?<!\d)(?:(\d{2}))?(\d{2})(\d{2})(\d{2})[ \t]*[-+]?[ \t]*(\d{4})(?!\d)/gu;

/** Characters that change nothing a reader sees, and could hide a number. */
const INVISIBLE = /[­​-‏⁠-⁤﻿]/gu;

export function holdsPersonalIdentityNumber(text: string): boolean {
  const folded = text.normalize("NFKC").replace(INVISIBLE, "");
  for (const match of folded.matchAll(CANDIDATE)) {
    const [, century, year, month, day, last] = match;
    if (
      year !== undefined &&
      month !== undefined &&
      day !== undefined &&
      last !== undefined &&
      isDay(century, year, month, day) &&
      luhn(`${year}${month}${day}${last}`)
    ) {
      return true;
    }
  }
  return false;
}

function isDay(
  century: string | undefined,
  year: string,
  month: string,
  day: string,
): boolean {
  const monthNumber = Number(month);
  const written = Number(day);
  // A coordination number adds 60 to the day.
  const dayNumber = written > 60 ? written - 60 : written;
  if (monthNumber < 1 || monthNumber > 12 || dayNumber < 1) {
    return false;
  }
  // Without a century, the year is read in the 2000s. Two digits other than 00
  // make a leap year in every century alike, and 00 is read as 2000, which was
  // one, so 29 February is allowed exactly where some century has it.
  const fullYear =
    century === undefined ? 2000 + Number(year) : Number(`${century}${year}`);
  const length = new Date(Date.UTC(fullYear, monthNumber, 0)).getUTCDate();
  return dayNumber <= length;
}

function luhn(digits: string): boolean {
  let sum = 0;
  for (let index = 0; index < digits.length; index++) {
    let digit = Number(digits[index]);
    if (index % 2 === 0) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }
    sum += digit;
  }
  return sum % 10 === 0;
}
