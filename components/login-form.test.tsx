import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "@/messages/fr.json";
import { LoginForm } from "./login-form";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function submitAddress() {
  render(
    <NextIntlClientProvider locale="fr" messages={messages} timeZone="UTC">
      <LoginForm />
    </NextIntlClientProvider>,
  );
  const email = screen.getByRole("textbox", {
    name: messages.login.emailLabel,
  });
  fireEvent.change(email, { target: { value: "reviewer@un.org" } });
  fireEvent.click(screen.getByRole("button", { name: messages.login.submit }));
  return email;
}

describe("shared transcripts sign-in", () => {
  it("sends the locale and address, and preserves the translated confirmation and expiry hint", async () => {
    const request = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", request);
    submitAddress();
    const confirmation = await screen.findByRole("status");
    expect(confirmation).toHaveTextContent(
      messages.login.sentBody.replace("{email}", "reviewer@un.org"),
    );
    expect(confirmation).toHaveTextContent(messages.login.sentSpamHint);
    expect(request).toHaveBeenCalledWith("/api/auth/request-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "reviewer@un.org", locale: "fr" }),
    });
  });

  it("keeps the form retryable after a network failure", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("Offline"))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", request);
    const email = submitAddress();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      messages.login.errorSendFailed,
    );
    expect(email).toHaveAttribute("aria-invalid", "true");
    expect(email).toHaveAttribute(
      "aria-describedby",
      screen.getByRole("alert").id,
    );
    fireEvent.click(
      screen.getByRole("button", { name: messages.login.submit }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "reviewer@un.org",
    );
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not show success for a failed HTTP response", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue({ ok: false, json: async () => ({ ok: true }) }),
    );
    submitAddress();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      messages.login.errorSendFailed,
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
