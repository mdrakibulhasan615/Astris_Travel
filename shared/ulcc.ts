/**
 * Ultra-low-cost carriers Duffel does not sell. Full-service and hybrid airlines (Malaysia Airlines,
 * Singapore, Emirates, Qatar, Turkish, Pegasus, Scoot, British Airways, Lufthansa…) are bookable
 * through Duffel; the airlines below sell only on their own channels, so their fares are shown as a
 * partner hand-off ("Book direct on AirAsia") and never go through the checkout API.
 *
 * To add an airline, add a row. To move one onto Duffel, delete it: its fares then come from Duffel.
 */

export interface UlccCarrier {
  /** IATA airline code, as it appears in a flight number (`AK 6102`). */
  code: string;
  /** Name used in the button: "Book direct on {name}". */
  name: string;
}

export const ULCC_CARRIERS: readonly UlccCarrier[] = [
  { code: 'AK', name: 'AirAsia' },
  { code: 'D7', name: 'AirAsia X' },
  { code: 'FD', name: 'Thai AirAsia' },
  { code: 'QZ', name: 'Indonesia AirAsia' },
  { code: 'Z2', name: 'AirAsia Philippines' },
  { code: 'XJ', name: 'Thai AirAsia X' },
  { code: 'FR', name: 'Ryanair' },
  { code: 'W6', name: 'Wizz Air' },
  { code: 'VZ', name: 'Thai Vietjet' },
  { code: 'VJ', name: 'Vietjet' },
  { code: '5J', name: 'Cebu Pacific' },
];

const BY_CODE = new Map(ULCC_CARRIERS.map((c) => [c.code, c]));

/** The ULCC entry for an airline code, or undefined for any airline that is not a ULCC. */
export function ulccCarrier(code: string | undefined | null): UlccCarrier | undefined {
  return code ? BY_CODE.get(code.trim().toUpperCase()) : undefined;
}
