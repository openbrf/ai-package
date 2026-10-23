// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import i18next from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import en from "../locales/en.json";
import sv from "../locales/sv.json";
import type { SiteTurnResponse } from "../src/assistant/site-assistant.ts";
import View from "../src/view/View.tsx";

/**
 * The view as the host renders it: inside the host's i18next, with the
 * package's translations merged under `plugin-ai-package`, talking to the
 * package's own route on the same origin.
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

const ROUTE = "/api/plugin/ai-package/assistants/site/turns";

const PROPOSED: SiteTurnResponse = {
  outcome: "answered",
  answer: "Nyheten om städdagen väntar på din bekräftelse.",
  proposals: [
    {
      id: "change-1",
      action: "news_create",
      title: "Skapa en nyhet",
      path: "/app/pending-changes/change-1",
      expiresAt: "2026-10-29T09:41:12.000Z",
    },
  ],
};

interface Sent {
  turnId: string;
  messages: { role: string; text: string }[];
}

/** The route, answering each turn with the next of `answers`. */
function serve(...answers: (SiteTurnResponse | number | Error)[]) {
  const sent: Sent[] = [];
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    expect(input).toBe(ROUTE);
    sent.push(JSON.parse(String(init?.body)) as Sent);
    const next = answers.shift();
    if (next === undefined) {
      throw new Error("No answer queued.");
    }
    if (next instanceof Error) {
      throw next;
    }
    return typeof next === "number"
      ? new Response("", { status: next })
      : Response.json(next);
  });
  vi.stubGlobal("fetch", fetch);
  return { fetch, sent };
}

function show() {
  return render(
    <I18nextProvider i18n={i18n}>
      <View />
    </I18nextProvider>,
  );
}

function ask(text: string): void {
  fireEvent.change(screen.getByLabelText("Vad vill du skriva eller ändra?"), {
    target: { value: text },
  });
  fireEvent.click(screen.getByRole("button", { name: "Skicka" }));
}

describe("the assistant's view", () => {
  it("says that nothing changes before the person confirms, and that it mails nobody", () => {
    serve();
    show();

    expect(screen.getByRole("heading", { name: "AI-assistent" })).toBeTruthy();
    expect(
      screen.getByText(/ingenting ändras förrän du har läst och bekräftat/),
    ).toBeTruthy();
    expect(
      screen.getByText(/kan inte skicka något till medlemmarna/),
    ).toBeTruthy();
  });

  it("sends what the person asks, and links each proposed change to the screen that confirms it", async () => {
    const { sent } = serve(PROPOSED);
    show();

    ask("Skriv en nyhet om städdagen.");

    const link = await screen.findByRole("link", {
      name: "Läs och bekräfta: Skapa en nyhet",
    });
    expect(link.getAttribute("href")).toBe("/app/pending-changes/change-1");
    expect(
      screen.getByText("Nyheten om städdagen väntar på din bekräftelse."),
    ).toBeTruthy();
    expect(screen.getByText("Förfaller 29 oktober 2026")).toBeTruthy();
    expect(sent).toEqual([
      {
        turnId: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        ),
        messages: [{ role: "user", text: "Skriv en nyhet om städdagen." }],
      },
    ]);
    // The view confirms nothing: its only buttons send and start over.
    expect(
      screen.getAllByRole("button").map((button) => button.textContent),
    ).toEqual(["Skicka", "Ny konversation"]);
  });

  it("sends one turn at a time", async () => {
    let answer = (_response: Response): void => undefined;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetch);
    show();

    ask("Skriv en nyhet.");
    expect(await screen.findByRole("status")).toBeTruthy();
    ask("Och en till.");

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(
      (screen.getByRole("button", { name: "Skicka" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "Ny konversation",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    answer(Response.json(PROPOSED));
    expect(await screen.findByRole("link")).toBeTruthy();
  });

  it("sends a turn that got no answer again under the same id", async () => {
    const { sent } = serve(new TypeError("Failed to fetch"), {
      outcome: "repeated",
      proposals: PROPOSED.outcome === "answered" ? PROPOSED.proposals : [],
    });
    show();

    ask("Skriv en nyhet om städdagen.");
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Frågan kunde inte skickas. Kontrollera anslutningen och försök igen.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Försök igen" }));

    expect(await screen.findByRole("link")).toBeTruthy();
    expect(screen.getByText("Den här frågan var redan besvarad.")).toBeTruthy();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    // The failure is gone with its cause.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("carries the conversation on, leaving out a turn that got no words", async () => {
    const { sent } = serve(
      PROPOSED,
      {
        outcome: "refused",
        reason: "rate-limited",
        retryAfterSeconds: 30,
        proposals: [],
      },
      { outcome: "answered", answer: "Klart.", proposals: [] },
    );
    show();

    ask("Skriv en nyhet om städdagen.");
    await screen.findByRole("link");
    ask("Publicera den.");
    expect(
      await screen.findByText(
        "För många frågor just nu. Försök igen om en minut.",
      ),
    ).toBeTruthy();
    ask("Publicera den nu.");
    await screen.findByText("Klart.");

    expect(sent[2]?.messages).toEqual([
      { role: "user", text: "Skriv en nyhet om städdagen." },
      {
        role: "assistant",
        text: "Nyheten om städdagen väntar på din bekräftelse.",
      },
      { role: "user", text: "Publicera den nu." },
    ]);
    expect(new Set(sent.map((turn) => turn.turnId)).size).toBe(3);
  });

  it("says so when the person may not change the news and the pages", async () => {
    serve(403);
    show();

    ask("Skriv en nyhet.");

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Du har inte behörighet att ändra föreningens nyheter och sidor.",
    );
    expect(screen.queryByRole("button", { name: "Försök igen" })).toBeNull();
  });

  it("starts over with an empty conversation", async () => {
    serve(PROPOSED);
    show();
    ask("Skriv en nyhet.");
    await screen.findByRole("link");

    fireEvent.click(screen.getByRole("button", { name: "Ny konversation" }));

    expect(screen.queryByRole("list")).toBeNull();
  });

  it("gives every button and link a touch target of at least 44px", async () => {
    serve(PROPOSED);
    show();
    ask("Skriv en nyhet.");
    const link = await screen.findByRole("link");

    for (const element of [...screen.getAllByRole("button"), link]) {
      expect(element.style.minHeight).toBe("44px");
    }
  });

  it("speaks English when the person does", async () => {
    serve(PROPOSED);
    await i18n.changeLanguage("en");
    try {
      show();
      fireEvent.change(
        screen.getByLabelText("What do you want to write or change?"),
        { target: { value: "Write a news item." } },
      );
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      const proposals = await screen.findByRole("link", {
        name: "Read and confirm: Skapa en nyhet",
      });
      expect(proposals).toBeTruthy();
      expect(screen.getByText("Expires October 29, 2026")).toBeTruthy();
    } finally {
      await i18n.changeLanguage("sv");
    }
    await waitFor(() => {
      expect(i18n.language).toBe("sv");
    });
  });
});
