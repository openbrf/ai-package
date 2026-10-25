// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import i18next from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import en from "../locales/en.json";
import sv from "../locales/sv.json";
import type {
  AgendaDraft,
  MeetingChoices,
  MinutesDraft,
} from "../src/meeting-support.ts";
import MeetingSupport from "../src/view/MeetingSupport.tsx";

/**
 * Meeting support's part of the view, as the host renders it: inside the
 * host's i18next, talking to the package's own meeting routes.
 */

const i18n = i18next.createInstance();

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: "sv",
    fallbackLng: "sv",
    ns: ["plugin-ai-package"],
    resources: {
      sv: { "plugin-ai-package": sv },
      en: { "plugin-ai-package": en },
    },
    interpolation: { escapeValue: false },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ROUTE = "/api/plugin/ai-package/meetings";

const MEETINGS: MeetingChoices = {
  meetings: [
    {
      id: "meeting-extra",
      kind: "EXTRAORDINARY",
      heldOn: "2027-02-10",
      summoned: false,
      held: false,
    },
    {
      id: "meeting-2027",
      kind: "ORDINARY",
      heldOn: "2027-05-12",
      summoned: false,
      held: false,
    },
    {
      id: "meeting-summoned",
      kind: "EXTRAORDINARY",
      heldOn: "2026-11-30",
      summoned: true,
      held: false,
    },
    {
      id: "meeting-2026",
      kind: "ORDINARY",
      heldOn: "2026-05-13",
      summoned: true,
      held: true,
    },
  ],
  more: false,
};

const AGENDA: AgendaDraft = {
  items: [
    { title: "Stämmans öppnande" },
    { title: "Val av ordförande vid stämman" },
    { title: "Motion om laddstolpar" },
  ],
  note: "Utgår från dagordningen vid stämman 2026. Kontrollera motionerna.",
  pendingChange: {
    id: "pending-1",
    expiresAt: "2026-10-31T09:41:12.000Z",
    path: "/app/pending-changes/pending-1",
  },
};

const MINUTES: MinutesDraft = {
  draft: "§ 1 Stämmans öppnande\nOrdföranden förklarade stämman öppnad.",
  complete: true,
};

interface Call {
  url: string;
  method: string;
  body: unknown;
}

type Answer = unknown | number | Error | { status: number; body: unknown };

/**
 * The routes: the meetings list answers with `list`, and each draft with the
 * next of `answers`. An answer may be held back until the test releases it.
 */
function serve(list: Answer = MEETINGS, ...answers: Answer[]) {
  const calls: Call[] = [];
  const held: ((response: Response) => void)[] = [];
  const respond = (answer: Answer): Response => {
    if (answer instanceof Error) {
      throw answer;
    }
    if (typeof answer === "number") {
      return new Response("", { status: answer });
    }
    if (
      typeof answer === "object" &&
      answer !== null &&
      "status" in answer &&
      "body" in answer
    ) {
      const { status, body } = answer as { status: number; body: unknown };
      return Response.json(body, { status });
    }
    return Response.json(answer);
  };
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({
      url,
      method,
      body:
        init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    if (url === ROUTE && method === "GET") {
      return respond(list);
    }
    const next = answers.shift();
    if (next === "hold") {
      return new Promise<Response>((resolve) => held.push(resolve));
    }
    if (next === undefined) {
      throw new Error("No answer queued.");
    }
    return respond(next);
  });
  vi.stubGlobal("fetch", fetch);
  return {
    calls,
    drafts: () => calls.filter((call) => call.method === "POST"),
    release: (answer: Answer) => {
      held.shift()?.(respond(answer));
    },
  };
}

async function show() {
  const view = render(
    <I18nextProvider i18n={i18n}>
      <MeetingSupport />
    </I18nextProvider>,
  );
  await waitFor(() => {
    expect(
      screen.queryByText(/^(Läser stämmorna|Reading the meetings)/),
    ).toBeNull();
  });
  return view;
}

function agendaForm(): HTMLElement {
  return screen
    .getByRole("heading", { name: "Förslag till dagordning" })
    .closest("div") as HTMLElement;
}

function minutesForm(): HTMLElement {
  return screen
    .getByRole("heading", { name: "Utkast till protokoll" })
    .closest("div") as HTMLElement;
}

/** A paragraph by all of its text: a date in it is an element of its own. */
function paragraph(text: string): HTMLElement {
  return screen.getByText(
    (_content, element) =>
      element?.tagName === "P" && element.textContent === text,
  );
}

function askAgenda(request = ""): void {
  const form = agendaForm();
  if (request !== "") {
    fireEvent.change(within(form).getByLabelText("Önskemål (frivilligt)"), {
      target: { value: request },
    });
  }
  fireEvent.click(
    within(form).getByRole("button", { name: "Föreslå dagordning" }),
  );
}

function askMinutes(notes: string): void {
  const form = minutesForm();
  fireEvent.change(within(form).getByLabelText("Dina anteckningar"), {
    target: { value: notes },
  });
  fireEvent.click(
    within(form).getByRole("button", { name: "Skriv utkast till protokoll" }),
  );
}

describe("meeting support's view", () => {
  it("offers an agenda draft only for a meeting being arranged", async () => {
    serve();
    await show();

    const options = within(
      within(agendaForm()).getByLabelText("Stämma"),
    ).getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "Extra föreningsstämma 10 februari 2027",
      "Ordinarie föreningsstämma 12 maj 2027",
    ]);
  });

  it("says so when no meeting is being arranged", async () => {
    serve({
      meetings: MEETINGS.meetings.filter((meeting) => meeting.summoned),
      more: false,
    });
    await show();

    expect(screen.getByText(/Ingen stämma är under planering/)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Föreslå dagordning" }),
    ).toBeNull();
  });

  it("asks for an agenda draft and links to the pending change, with no button to confirm it", async () => {
    const { drafts } = serve(MEETINGS, { status: 201, body: AGENDA });
    await show();

    fireEvent.change(within(agendaForm()).getByLabelText("Stämma"), {
      target: { value: "meeting-2027" },
    });
    askAgenda("  Ta upp frågan om laddstolpar.  ");

    const link = await screen.findByRole("link", {
      name: "Läs och bekräfta dagordningen",
    });
    expect(link.getAttribute("href")).toBe("/app/pending-changes/pending-1");
    expect(drafts()).toEqual([
      {
        url: `${ROUTE}/meeting-2027/agenda-draft`,
        method: "POST",
        body: { instructions: "Ta upp frågan om laddstolpar.", language: "sv" },
      },
    ]);

    const result = screen
      .getByText(/^Förslag till dagordning för/)
      .closest("section") as HTMLElement;
    expect(result.textContent).toContain(
      "Förslag till dagordning för Ordinarie föreningsstämma 12 maj 2027",
    );
    expect(
      within(result)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(AGENDA.items.map((item) => item.title));
    expect(within(result).getByText(AGENDA.note)).toBeTruthy();
    const expires = within(result).getByText("31 oktober 2026");
    expect(expires.parentElement?.textContent).toBe(
      "Förfaller 31 oktober 2026",
    );
    expect(expires.style.fontFamily).toBe("var(--obrf-font-data)");
    expect(within(result).queryByRole("button")).toBeNull();
    expect(screen.queryByRole("button", { name: /bekräfta/i })).toBeNull();
  });

  it("sends no request field when none was written", async () => {
    const { drafts } = serve(MEETINGS, { status: 201, body: AGENDA });
    await show();

    askAgenda("   ");
    await screen.findByRole("link", { name: "Läs och bekräfta dagordningen" });

    expect(drafts()[0]?.body).toEqual({ language: "sv" });
  });

  it("links the pending changes screen when the path given is not on this origin", async () => {
    serve(MEETINGS, {
      status: 201,
      body: {
        ...AGENDA,
        pendingChange: { ...AGENDA.pendingChange, path: "//evil.example/x" },
      },
    });
    await show();

    askAgenda();

    expect(
      (
        await screen.findByRole("link", {
          name: "Läs och bekräfta dagordningen",
        })
      ).getAttribute("href"),
    ).toBe("/app/pending-changes");
  });

  it("asks for one agenda draft at a time", async () => {
    const { drafts, release } = serve(MEETINGS, "hold");
    await show();

    askAgenda();
    askAgenda();

    expect(drafts()).toHaveLength(1);
    const button = within(agendaForm()).getByRole("button", {
      name: "Föreslå dagordning",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toBe(
      "Assistenten skriver dagordningen …",
    );

    release({ status: 201, body: AGENDA });
    await screen.findByRole("link", { name: "Läs och bekräfta dagordningen" });
    expect(button.disabled).toBe(false);
  });

  it("shows a draft for the meeting it was asked for, after another is chosen", async () => {
    const { release } = serve(MEETINGS, "hold");
    await show();

    askAgenda();
    fireEvent.change(within(agendaForm()).getByLabelText("Stämma"), {
      target: { value: "meeting-2027" },
    });
    release({ status: 201, body: AGENDA });

    await screen.findByRole("link", { name: "Läs och bekräfta dagordningen" });
    expect(
      paragraph(
        "Förslag till dagordning för Extra föreningsstämma 10 februari 2027",
      ),
    ).toBeTruthy();
  });

  it("says the draft may have been proposed when no answer came back", async () => {
    serve(MEETINGS, new TypeError("Failed to fetch"));
    await show();

    askAgenda();

    expect((await screen.findByRole("alert")).textContent).toMatch(
      /^Inget svar kom tillbaka\. Förslaget kan ändå ha lagts fram/,
    );
    expect(
      screen
        .getByRole("link", { name: "Öppna Väntande ändringar" })
        .getAttribute("href"),
    ).toBe("/app/pending-changes");
  });

  it("treats a server fault as an answer that may not have come", async () => {
    serve(MEETINGS, 500);
    await show();

    askAgenda();

    expect((await screen.findByRole("alert")).textContent).toMatch(
      /^Inget svar kom tillbaka\. Förslaget kan ändå ha lagts fram/,
    );
  });

  it("clears a refusal once another meeting is chosen", async () => {
    serve(MEETINGS, {
      status: 409,
      body: { reason: "notice-already-issued" },
    });
    await show();

    askAgenda();
    await screen.findByRole("alert");
    fireEvent.change(within(agendaForm()).getByLabelText("Stämma"), {
      target: { value: "meeting-2027" },
    });

    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("drops a refusal that arrives after another meeting was chosen", async () => {
    const { release } = serve(MEETINGS, "hold");
    await show();

    askAgenda();
    fireEvent.change(within(agendaForm()).getByLabelText("Stämma"), {
      target: { value: "meeting-2027" },
    });
    release({ status: 409, body: { reason: "notice-already-issued" } });

    await waitFor(() => {
      expect(screen.queryByRole("status")).toBeNull();
    });
    expect(screen.queryByRole("alert")).toBeNull();
    // The answer is in, so another draft may be asked for.
    expect(
      (
        within(agendaForm()).getByRole("button", {
          name: "Föreslå dagordning",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it("drops a refusal that arrives after the request was changed", async () => {
    const { release } = serve(MEETINGS, "hold");
    await show();

    askAgenda("Ta upp frågan om laddstolpar.");
    fireEvent.change(
      within(agendaForm()).getByLabelText("Önskemål (frivilligt)"),
      {
        target: { value: "Ta upp frågan om cykelrum." },
      },
    );
    release({ status: 409, body: { reason: "meeting-already-held" } });

    await waitFor(() => {
      expect(screen.queryByRole("status")).toBeNull();
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps a draft that arrives after another meeting was chosen, and names its meeting", async () => {
    const { release } = serve(MEETINGS, "hold");
    await show();

    askAgenda();
    fireEvent.change(
      within(agendaForm()).getByLabelText("Önskemål (frivilligt)"),
      {
        target: { value: "Något annat." },
      },
    );
    release({ status: 201, body: AGENDA });

    expect(
      (
        await screen.findByRole("link", {
          name: "Läs och bekräfta dagordningen",
        })
      ).getAttribute("href"),
    ).toBe("/app/pending-changes/pending-1");
  });

  it("keeps an agenda request that got no answer, with its meeting, after another meeting was chosen", async () => {
    const { release } = serve(MEETINGS, "hold");
    await show();

    askAgenda();
    fireEvent.change(within(agendaForm()).getByLabelText("Stämma"), {
      target: { value: "meeting-2027" },
    });
    release(500);

    expect((await screen.findByRole("alert")).textContent).toMatch(
      /^Inget svar kom tillbaka/,
    );
    expect(
      screen.getByText(/^Begäran om Extra föreningsstämma/).textContent,
    ).toBe("Begäran om Extra föreningsstämma 10 februari 2027");
    expect(
      screen.getByRole("link", { name: "Öppna Väntande ändringar" }),
    ).toBeTruthy();

    // Changing the choice again does not hide that a proposal may exist.
    fireEvent.change(within(agendaForm()).getByLabelText("Stämma"), {
      target: { value: "meeting-extra" },
    });
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("drops a refusal of minutes notes that were corrected before it arrived", async () => {
    const { release } = serve(MEETINGS, "hold");
    await show();

    askMinutes("Anteckningar med 19121212-1212.");
    fireEvent.change(
      within(minutesForm()).getByLabelText("Dina anteckningar"),
      {
        target: { value: "Anteckningar utan personnummer." },
      },
    );
    release({ status: 422, body: { reason: "personal-identity-number" } });

    await waitFor(() => {
      expect(screen.queryByRole("status")).toBeNull();
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      (
        within(minutesForm()).getByRole("button", {
          name: "Skriv utkast till protokoll",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it("drops a refusal of minutes that arrives after another meeting was chosen", async () => {
    const { release } = serve(MEETINGS, "hold");
    await show();

    askMinutes("Ordföranden öppnade stämman.");
    fireEvent.change(within(minutesForm()).getByLabelText("Stämma"), {
      target: { value: "meeting-2027" },
    });
    release({ status: 422, body: { reason: "personal-identity-number" } });

    await waitFor(() => {
      expect(screen.queryByRole("status")).toBeNull();
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("sets every date the view writes in the data face", async () => {
    serve(MEETINGS, { status: 201, body: AGENDA }, MINUTES);
    await show();

    for (const form of [agendaForm(), minutesForm()]) {
      expect(
        (within(form).getByLabelText("Stämma") as HTMLElement).style.fontFamily,
      ).toBe("var(--obrf-font-data)");
    }

    askAgenda();
    await screen.findByRole("link", { name: "Läs och bekräfta dagordningen" });
    const heading = paragraph(
      "Förslag till dagordning för Extra föreningsstämma 10 februari 2027",
    );
    expect(within(heading).getByText("10 februari 2027").style.fontFamily).toBe(
      "var(--obrf-font-data)",
    );

    askMinutes("Ordföranden öppnade stämman.");
    await screen.findByLabelText(
      "Utkast till protokoll för Ordinarie föreningsstämma 13 maj 2026",
    );
    // The options are text of their own: only the heading's day is an element.
    expect(screen.getByText("13 maj 2026").style.fontFamily).toBe(
      "var(--obrf-font-data)",
    );
  });

  it("writes a minutes draft from the notes, to copy, and keeps it nowhere", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const { drafts } = serve(MEETINGS, MINUTES);
    await show();

    const options = within(
      within(minutesForm()).getByLabelText("Stämma"),
    ).getAllByRole("option") as HTMLOptionElement[];
    expect(options.map((option) => option.textContent)).toEqual([
      "Extra föreningsstämma 10 februari 2027 (under planering)",
      "Ordinarie föreningsstämma 12 maj 2027 (under planering)",
      "Extra föreningsstämma 30 november 2026 (kallelsen skickad)",
      "Ordinarie föreningsstämma 13 maj 2026 (hållen)",
    ]);
    // The meeting held last is the one usually minuted.
    expect(options.find((option) => option.selected)?.value).toBe(
      "meeting-2026",
    );

    askMinutes("  Ordföranden öppnade stämman.  ");

    const draft = (await screen.findByLabelText(
      "Utkast till protokoll för Ordinarie föreningsstämma 13 maj 2026",
    )) as HTMLTextAreaElement;
    expect(draft.value).toBe(MINUTES.draft);
    expect(draft.readOnly).toBe(true);
    expect(drafts()).toEqual([
      {
        url: `${ROUTE}/meeting-2026/minutes-draft`,
        method: "POST",
        body: { notes: "Ordföranden öppnade stämman.", language: "sv" },
      },
    ]);
    expect(screen.getByText(/Utkastet finns bara här/)).toBeTruthy();
    expect(screen.queryByText(/slutar mitt i/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Kopiera utkastet" }));
    expect(await screen.findByText("Utkastet är kopierat.")).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith(MINUTES.draft);
  });

  it("says when the copy failed", async () => {
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: {
        writeText: async () => {
          throw new Error("Denied.");
        },
      },
    });
    serve(MEETINGS, MINUTES);
    await show();

    askMinutes("Anteckningar.");
    fireEvent.click(
      await screen.findByRole("button", { name: "Kopiera utkastet" }),
    );

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Utkastet kunde inte kopieras. Markera texten och kopiera den själv.",
    );
  });

  it("says when the minutes draft was cut short", async () => {
    serve(MEETINGS, { ...MINUTES, complete: false });
    await show();

    askMinutes("Anteckningar.");

    expect(
      await screen.findByText(
        "Utkastet blev för långt och slutar mitt i. Skriv resten själv utifrån anteckningarna.",
      ),
    ).toBeTruthy();
  });

  it("says when the notes changed after the draft was written", async () => {
    serve(MEETINGS, MINUTES);
    await show();

    askMinutes("Anteckningar.");
    await screen.findByRole("button", { name: "Kopiera utkastet" });
    fireEvent.change(
      within(minutesForm()).getByLabelText("Dina anteckningar"),
      {
        target: { value: "Anteckningar, rättade." },
      },
    );

    expect(
      screen.getByText("Du har ändrat anteckningarna sedan utkastet skrevs."),
    ).toBeTruthy();
  });

  it("asks for nothing with notes that are only blanks, and one minutes draft at a time", async () => {
    const { drafts, release } = serve(MEETINGS, "hold");
    await show();
    const button = within(minutesForm()).getByRole("button", {
      name: "Skriv utkast till protokoll",
    }) as HTMLButtonElement;

    askMinutes(" \n\t ");
    expect(button.disabled).toBe(true);
    expect(drafts()).toHaveLength(0);

    askMinutes("Anteckningar.");
    fireEvent.click(button);
    expect(drafts()).toHaveLength(1);
    expect(button.disabled).toBe(true);

    release(MINUTES);
    await screen.findByRole("button", { name: "Kopiera utkastet" });
    expect(button.disabled).toBe(false);
  });

  /**
   * Every reason the meeting routes answer with (README, "Meeting support"),
   * the gateway's among them, and the platform's own for a meeting it does
   * not have.
   */
  const REASONS = [
    "host-unsupported",
    "connected-app",
    "entitlement-required",
    "provider-not-configured",
    "usage-limit-reached",
    "rate-limited",
    "provider-failed",
    "notice-already-issued",
    "meeting-already-held",
    "no-draft",
    "personal-identity-number",
    "invalid-body",
    "meeting-not-found",
  ];

  it("has a sentence in Swedish and in English for every refusal", () => {
    const refused = (catalogue: typeof sv) =>
      catalogue.meetings.refused as Record<string, string>;
    for (const reason of REASONS) {
      expect(refused(sv)[reason]?.length ?? 0, reason).toBeGreaterThan(0);
      expect(refused(en)[reason]?.length ?? 0, reason).toBeGreaterThan(0);
    }
    expect(Object.keys(refused(en)).sort()).toEqual(
      Object.keys(refused(sv)).sort(),
    );
  });

  it.each(REASONS)("says why a draft was refused with %s", async (reason) => {
    serve(MEETINGS, { status: 409, body: { reason } });
    await show();

    askMinutes("Anteckningar.");

    expect((await screen.findByRole("alert")).textContent).toBe(
      (sv.meetings.refused as Record<string, string>)[reason],
    );
  });

  it("says how long to wait when the limit says", async () => {
    serve(MEETINGS, {
      status: 429,
      body: { reason: "rate-limited", retryAfterSeconds: 30 },
    });
    await show();

    askAgenda();

    expect((await screen.findByRole("alert")).textContent).toBe(
      "För många förfrågningar just nu. Försök igen om 30 sekunder.",
    );
  });

  it("says so when the person may not manage general meetings", async () => {
    serve({ status: 403, body: { statusCode: 403 } });
    await show();

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Du har inte behörighet att hantera föreningsstämmor.",
    );
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("reads the meetings again after a failed read", async () => {
    let first = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        if (first) {
          first = false;
          throw new TypeError("Failed to fetch");
        }
        return Response.json(MEETINGS);
      }),
    );
    await show();

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Stämmorna kunde inte läsas just nu. Kontrollera anslutningen och försök igen.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Försök igen" }));

    expect(
      await screen.findByRole("button", { name: "Föreslå dagordning" }),
    ).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says so when the association has no meeting", async () => {
    serve({ meetings: [], more: false });
    await show();

    expect(
      screen.getByText(/Föreningen har inte planerat in någon stämma än/),
    ).toBeTruthy();
  });

  it("gives every button, list and link a touch target of at least 44px", async () => {
    serve(MEETINGS, { status: 201, body: AGENDA });
    await show();

    askAgenda();
    const link = await screen.findByRole("link", {
      name: "Läs och bekräfta dagordningen",
    });

    for (const element of [
      ...screen.getAllByRole("button"),
      ...screen.getAllByRole("combobox"),
      link,
    ]) {
      expect(element.style.minHeight).toBe("44px");
    }
  });

  it("asks for the draft in English when the person speaks it", async () => {
    const { drafts } = serve(MEETINGS, { status: 201, body: AGENDA });
    await i18n.changeLanguage("en");
    try {
      await show();
      fireEvent.click(
        screen.getByRole("button", { name: "Propose an agenda" }),
      );

      expect(
        await screen.findByRole("link", {
          name: "Read and confirm the agenda",
        }),
      ).toBeTruthy();
      expect(
        paragraph(
          "Agenda draft for Extraordinary general meeting February 10, 2027",
        ),
      ).toBeTruthy();
      expect(drafts()[0]?.body).toEqual({ language: "en" });
    } finally {
      await i18n.changeLanguage("sv");
    }
  });
});
