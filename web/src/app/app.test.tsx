import { onlineManager } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { App } from "@/app/app";

const HEALTH_CHECK_INTERVAL_MILLISECONDS = 60000;

function backendAnswers(body: unknown, status = 200) {
  const fetchFromBackend = vi.fn(async () => Response.json(body, { status }));
  vi.stubGlobal("fetch", fetchFromBackend);
  return fetchFromBackend;
}

beforeEach(() => {
  window.history.pushState({}, "", "/throne/");
});

afterEach(() => {
  vi.useRealTimers();
  onlineManager.setOnline(true);
});

test("the app shell shows that the backend answered", async () => {
  const fetchFromBackend = backendAnswers({ ok: true });

  render(<App />);

  expect(await screen.findByText("The backend answered")).toBeTruthy();
  expect(fetchFromBackend).toHaveBeenCalledTimes(1);
  expect(fetchFromBackend).toHaveBeenCalledWith("/throne/api/health");
});

test("the app shell names the field when the backend answers the wrong shape", async () => {
  backendAnswers({ ok: "yes" });

  render(<App />);

  expect(await screen.findByText(/did not answer: health response does not match its contract: ok:/)).toBeTruthy();
});

test("the app shell says so when the backend refuses", async () => {
  backendAnswers({}, 500);

  render(<App />);

  expect(await screen.findByText(/did not answer: health answered 500/)).toBeTruthy();
});

test("the app also opens at the root of the listener", async () => {
  window.history.pushState({}, "", "/");
  backendAnswers({ ok: true });

  render(<App />);

  expect(await screen.findByText("Throne")).toBeTruthy();
});

test("an address with no page keeps the app shell and says there is no page there", async () => {
  window.history.pushState({}, "", "/throne/nothing-here");
  backendAnswers({ ok: true });

  render(<App />);

  expect(await screen.findByText("There is no page at this address.")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Where I stand" })).toBeTruthy();
});

test("the app shell notices the backend stop answering without the window losing focus", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  backendAnswers({ ok: true });
  render(<App />);
  await screen.findByText("The backend answered");

  backendAnswers({}, 500);
  await act(() => vi.advanceTimersByTimeAsync(HEALTH_CHECK_INTERVAL_MILLISECONDS));

  expect(await screen.findByText(/did not answer: health answered 500/)).toBeTruthy();
});

test("a backend that has never answered is announced once, however often it is asked again", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  backendAnswers({}, 500);
  render(<App />);
  const region = await screen.findByText(/did not answer: health answered 500/);
  const announced: string[] = [];
  new MutationObserver(() => announced.push(region.textContent)).observe(region, { childList: true, characterData: true, subtree: true });
  const answerStaysOnItsWay = vi.fn(() => new Promise(() => undefined));
  vi.stubGlobal("fetch", answerStaysOnItsWay);

  await act(() => vi.advanceTimersByTimeAsync(HEALTH_CHECK_INTERVAL_MILLISECONDS));

  expect(answerStaysOnItsWay).toHaveBeenCalledTimes(1);
  expect(announced).toEqual([]);
});

test("offline, the shell does not say the backend answered", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  backendAnswers({ ok: true });
  render(<App />);
  await screen.findByText("The backend answered");

  vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
  window.dispatchEvent(new Event("offline"));
  await act(() => vi.advanceTimersByTimeAsync(HEALTH_CHECK_INTERVAL_MILLISECONDS));

  expect(await screen.findByText(/did not answer: Failed to fetch/)).toBeTruthy();
  expect(screen.queryByText("The backend answered")).toBeNull();
});

test("coming back online the shell says the backend answered without waiting for the next check", async () => {
  backendAnswers({ ok: true });
  render(<App />);
  await screen.findByText("The backend answered");
  vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
  window.dispatchEvent(new Event("offline"));
  await act(async () => {
    window.dispatchEvent(new Event("visibilitychange"));
  });
  await screen.findByText(/did not answer: Failed to fetch/);

  backendAnswers({ ok: true });
  await act(async () => {
    window.dispatchEvent(new Event("online"));
  });

  expect(await screen.findByText("The backend answered")).toBeTruthy();
});
