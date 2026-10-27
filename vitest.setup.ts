import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Vitest globals are disabled, so Testing Library cannot register its automatic
// afterEach hook. Unmount roots while jsdom still exists so queued React work
// cannot outlive the test environment and access a removed window.
afterEach(cleanup);
