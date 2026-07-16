import { expect, test } from "bun:test";
// Pure logic for the T2-13 "Connect to cloud" CTA lives under web/src/lib —
// imported by relative path so this test runs where CI actually executes it
// (`bun test tests/`, scoped by apps/pipeline-ui/bunfig.toml's `root =
// "tests"`). apps/pipeline-ui/web has its own Vitest suite for web-only
// logic (src/lib/__tests__/), but CI's web-build job only runs `bun run
// build` today — it does not invoke `bun run test` — so a spec placed there
// would not be exercised by CI. The imported module has zero external
// imports (no React/framer-motion/etc.), so pulling it in from a sibling
// package's test root is safe: nothing needs cross-package module
// resolution.
import { CLOUD_CONNECT_COMMAND, cloudConnectView } from "../web/src/lib/cloudConnect.ts";

test("cloudConnectView falls back to the invite when connection state is unknown", () => {
  expect(cloudConnectView(undefined)).toBe("invite");
  expect(cloudConnectView(null)).toBe("invite");
});

test("cloudConnectView only shows 'connected' on positive confirmation", () => {
  expect(cloudConnectView(true)).toBe("connected");
  expect(cloudConnectView(false)).toBe("invite");
});

test("the CTA advertises the real, shipped T1-16 command", () => {
  expect(CLOUD_CONNECT_COMMAND).toBe("pipeline cloud connect");
});
