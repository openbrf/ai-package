import type { ListedAction } from "../src/host-contract.ts";

/**
 * Every action the core lists on the `ai` surface, with its effect: what an
 * AI package can be offered at all.
 *
 * A copy of the list openbrf/openbrf pins in
 * `apps/api/src/actions/action-catalogue.spec.ts` ("offers the AI package
 * only what an ADR decided to"), where adding `ai` to an action is a line a
 * review has to see. When the core adds one, add it here: the exposure
 * scenario then offers it too (`world.ts`), and the corpus test fails until
 * the world can serve it.
 */
export const CORE_AI_ACTIONS: Readonly<Record<string, ListedAction["effect"]>> =
  {
    contact_message_list: "read",
    document_get: "read",
    document_list: "read",
    issue_get: "read",
    issue_list: "read",
    issue_type_list: "read",
    meeting_get: "read",
    meeting_list: "read",
    meeting_set_agenda: "write",
    motion_meeting_list: "read",
    news_create: "write",
    news_get: "read",
    news_list: "read",
    news_publish: "write",
    news_request_mailing: "write",
    news_set_visibility: "write",
    news_unpublish: "write",
    news_update: "write",
    page_create: "write",
    page_get: "read",
    page_list: "read",
    page_set_status: "write",
    page_unpublish: "write",
    page_update: "write",
  };

/** Every change the core lets an AI package propose. */
export const CORE_AI_WRITES: readonly string[] = Object.entries(CORE_AI_ACTIONS)
  .filter(([, effect]) => effect !== "read")
  .map(([name]) => name);
