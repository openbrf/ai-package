import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

import SiteAssistant from "./SiteAssistant.tsx";
import { NAMESPACE, styles } from "./styles.ts";

/**
 * The package's view, exposed as `./View` and loaded by the browser at
 * runtime, at `/app/plugin/ai-package` and in the board's section of the
 * navigation (the plugin contract, "Where a view is found").
 *
 * It holds the assistants the board works with. Every word on it is a key in
 * the package's namespace, `plugin-ai-package`, which the host merged from
 * `locales/` into the store the shared i18next holds.
 */
export default function AiPackageView(): ReactElement {
  const { t } = useTranslation(NAMESPACE);
  return (
    <section style={styles.panel}>
      <h2 style={styles.heading}>{t("view.title")}</h2>
      <SiteAssistant />
    </section>
  );
}
