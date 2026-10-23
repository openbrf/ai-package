import { describe, expect, it } from "vitest";

import { holdsPersonalIdentityNumber } from "../src/personal-identity-number.ts";

/**
 * The check that keeps a personal identity number in a board member's text
 * from reaching the model provider. Test numbers only, valid by the calendar
 * and the Luhn check and belonging to nobody.
 */

describe("a personal identity number in a board member's text", () => {
  it.each([
    ["with a hyphen", "Anna Berg 811228-9874 valdes."],
    ["with the century", "Anna Berg 19811228-9874 valdes."],
    ["as twelve digits", "198112289874"],
    ["as ten digits", "8112289874"],
    ["with a plus for a centenarian", "811228+9874"],
    ["with a space instead of the hyphen", "811228 9874"],
    ["as a coordination number", "811288-9871"],
    ["on 29 February without a century", "000229-1235"],
    ["on 29 February of a leap year", "20000229-1235"],
    ["in fullwidth digits", "８１１２２８-９８７４"],
    ["broken up by an invisible character", "8112​28-9874"],
  ])("is found %s", (_case, text) => {
    expect(holdsPersonalIdentityNumber(text)).toBe(true);
  });

  it.each([
    ["a wrong check digit", "811228-9875"],
    ["a month that does not exist", "811328-9874"],
    ["29 February of a year that had none", "19000229-1235"],
    ["an organisation number", "Föreningen 769612-3456 har ordet."],
    ["vote counts", "Bifall med 31 röster mot 4, 2 avstod."],
    ["a phone number in groups", "Ring 070-123 45 67."],
    ["a longer run of digits", "Bankgiro 98112289874"],
    ["a date and a time", "2027-05-20 18:00"],
  ])("is not found in %s", (_case, text) => {
    expect(holdsPersonalIdentityNumber(text)).toBe(false);
  });
});
