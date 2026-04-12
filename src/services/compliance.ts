import { env } from "../config";

/**
 * Fair Use Policy: all price data responses must include the discrepancy
 * report URL and a data-source notice.
 */
export function complianceFooter() {
  return {
    discrepancy_report_url: env.DISCREPANCY_REPORT_URL,
    data_notice:
      "Prices are sourced from the UK Government Fuel Finder scheme under the Open Government Licence. Data is presented without modification.",
  };
}
