import type { ActionRequest } from "@openbrf/plugin-sdk";

import type { ListedAction, ListFilter } from "../src/host-contract.ts";

/**
 * A stand-in for the core's document reads, `document_list` and
 * `document_get`, at the boundary the package reads them: `host.actions.list`
 * and `host.actions.invoke`. It answers in the shapes the core's
 * `document-actions.registrar.ts` publishes, and refuses as the registry
 * does, with an error named `ActionRefusal`. The reads themselves, and who
 * may read what, are the core's and are tested there.
 */

export interface StandInDocument {
  id: string;
  title: string;
  category: string;
  audience: "MEMBER" | "PUBLIC";
  /** Each page's text; an empty string is a scanned page. */
  pages: string[];
}

export const BYLAWS: StandInDocument = {
  id: "doc-bylaws",
  title: "Stadgar 2024",
  category: "Stadgar",
  audience: "MEMBER",
  pages: [
    "§ 1 Föreningens firma är Bostadsrättsföreningen Lönnen.",
    "§ 14 Styrelsen består av lägst tre och högst sju ledamöter.",
    "§ 23 Bostadsrättshavaren får inte utan styrelsens tillstånd göra ingrepp i en bärande konstruktion.",
  ],
};

export const MINUTES: StandInDocument = {
  id: "doc-minutes",
  title: "Protokoll styrelsemöte 2026-09-14",
  category: "Protokoll",
  audience: "MEMBER",
  pages: [
    "§ 5 Styrelsen beslutade att höja årsavgiften med 3 procent från 1 januari 2027.",
  ],
};

export const SCANNED: StandInDocument = {
  id: "doc-scanned",
  title: "Ekonomisk plan 1998",
  category: "Ekonomisk plan",
  audience: "PUBLIC",
  pages: ["", ""],
};

/** The listing's schemas, as the core publishes them, in short. */
const LISTED: readonly ListedAction[] = [
  {
    name: "document_list",
    description:
      "Lists the documents in the association's archive that this person may read.",
    group: "documents",
    personalData: ["name", "freeText"],
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        search: { type: "string" },
        category: { type: "string" },
        limit: { type: "integer" },
      },
    },
    outputSchema: { type: "object" },
  },
  {
    name: "document_get",
    description: "Reads the text of up to ten pages of one document.",
    group: "documents",
    personalData: ["name", "freeText"],
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: { type: "string" },
        fromPage: { type: "integer" },
        fromCharacter: { type: "integer" },
        toPage: { type: "integer" },
      },
    },
    outputSchema: { type: "object" },
  },
];

export interface Dispatched {
  request: ActionRequest;
  name: string;
  input: unknown;
}

export class ActionRefusalStandIn extends Error {
  override readonly name = "ActionRefusal";
  constructor(
    readonly kind: "registry" | "invalid-body" | "domain",
    readonly reason: string,
    readonly retry: "never" | "after-edit" | "after-backoff",
    private readonly published: Record<string, readonly unknown[]> = {},
  ) {
    super(`refused: ${reason}`);
  }

  readonly status = 400;
  readonly transport = "tool-result";

  details(): Record<string, readonly unknown[]> {
    return this.published;
  }
}

export class StandInArchive {
  readonly documents = new Map<string, StandInDocument>();
  readonly listed: Dispatched[] = [];
  readonly dispatched: Dispatched[] = [];
  /** What `list` answers with; the core's two reads unless a test says. */
  offered: ListedAction[] = [...LISTED];
  /** When set, `invoke` rejects with it instead of answering. */
  failWith: Error | null = null;
  /** The most characters one `document_get` answers with. */
  charactersPerRead = 60_000;

  constructor(documents: readonly StandInDocument[] = [BYLAWS, MINUTES]) {
    for (const document of documents) {
      this.documents.set(document.id, document);
    }
  }

  readonly list = async (
    request: ActionRequest,
    filter?: ListFilter,
  ): Promise<ListedAction[]> => {
    this.listed.push({ request, name: "list", input: filter });
    return this.offered.map((action) => structuredClone(action));
  };

  readonly invoke = async <Output>(
    request: ActionRequest,
    name: string,
    input: unknown,
  ): Promise<Output> => {
    this.dispatched.push({ request, name, input });
    if (this.failWith !== null) {
      throw this.failWith;
    }
    const fields = (input ?? {}) as Record<string, unknown>;
    if (name === "document_list") {
      const search =
        typeof fields.search === "string" ? fields.search.toLowerCase() : "";
      return {
        documents: [...this.documents.values()]
          .filter(
            (document) =>
              `${document.title} ${document.category}`
                .toLowerCase()
                .includes(search) &&
              (fields.category === undefined ||
                document.category === fields.category),
          )
          .map((document) => summary(document)),
        more: false,
      } as Output;
    }
    if (name === "document_get") {
      if (typeof fields.id !== "string") {
        throw new ActionRefusalStandIn(
          "invalid-body",
          "invalid-body",
          "after-edit",
          {
            issues: [{ path: ["id"], message: "Required" }],
          },
        );
      }
      const document = this.documents.get(fields.id);
      if (document === undefined) {
        throw new ActionRefusalStandIn("domain", "not-found", "after-edit");
      }
      const fromPage =
        typeof fields.fromPage === "number" ? fields.fromPage : 1;
      const toPage =
        typeof fields.toPage === "number" ? fields.toPage : fromPage + 9;
      let left = this.charactersPerRead;
      const pages: { number: number; text: string }[] = [];
      for (
        let number = fromPage;
        number <= Math.min(toPage, document.pages.length) && left > 0;
        number++
      ) {
        const text = (document.pages[number - 1] ?? "").slice(0, left);
        left -= text.length;
        pages.push({ number, text });
      }
      return {
        ...summary(document),
        pageCount: document.pages.length,
        pages,
        textLayer: pages.some((page) => page.text !== ""),
        truncated: false,
        next: null,
      } as Output;
    }
    throw new ActionRefusalStandIn("registry", "unknown-action", "never");
  };
}

function summary(document: StandInDocument) {
  return {
    id: document.id,
    title: document.title,
    category: document.category,
    audience: document.audience,
    fileName: `${document.id}.pdf`,
    byteSize: 1024,
    uploadedAt: "2026-09-15T08:00:00.000Z",
  };
}
