import { afterEach, describe, expect, it } from "vitest";
import type { BetterAuthOptions } from "better-auth";
import { getCookies } from "better-auth/cookies";
import {
  buildBetterAuthSessionOptions,
  buildBetterAuthAdvancedOptions,
  DEFAULT_AUTH_SESSION_EXPIRES_IN_SECONDS,
  DEFAULT_AUTH_SESSION_FRESH_AGE_SECONDS,
  DEFAULT_AUTH_SESSION_UPDATE_AGE_SECONDS,
  deriveAuthCookiePrefix,
  deriveAuthTrustedOrigins,
} from "../auth/better-auth.js";

const ORIGINAL_INSTANCE_ID = process.env.PAPERCLIP_INSTANCE_ID;
const ORIGINAL_SESSION_EXPIRES_IN = process.env.PAPERCLIP_AUTH_SESSION_EXPIRES_IN_SECONDS;
const ORIGINAL_SESSION_UPDATE_AGE = process.env.PAPERCLIP_AUTH_SESSION_UPDATE_AGE_SECONDS;
const ORIGINAL_SESSION_FRESH_AGE = process.env.PAPERCLIP_AUTH_SESSION_FRESH_AGE_SECONDS;

afterEach(() => {
  if (ORIGINAL_INSTANCE_ID === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
  else process.env.PAPERCLIP_INSTANCE_ID = ORIGINAL_INSTANCE_ID;
  if (ORIGINAL_SESSION_EXPIRES_IN === undefined) delete process.env.PAPERCLIP_AUTH_SESSION_EXPIRES_IN_SECONDS;
  else process.env.PAPERCLIP_AUTH_SESSION_EXPIRES_IN_SECONDS = ORIGINAL_SESSION_EXPIRES_IN;
  if (ORIGINAL_SESSION_UPDATE_AGE === undefined) delete process.env.PAPERCLIP_AUTH_SESSION_UPDATE_AGE_SECONDS;
  else process.env.PAPERCLIP_AUTH_SESSION_UPDATE_AGE_SECONDS = ORIGINAL_SESSION_UPDATE_AGE;
  if (ORIGINAL_SESSION_FRESH_AGE === undefined) delete process.env.PAPERCLIP_AUTH_SESSION_FRESH_AGE_SECONDS;
  else process.env.PAPERCLIP_AUTH_SESSION_FRESH_AGE_SECONDS = ORIGINAL_SESSION_FRESH_AGE;
});

describe("Better Auth cookie scoping", () => {
  it("derives an instance-scoped cookie prefix", () => {
    expect(deriveAuthCookiePrefix("default")).toBe("paperclip-default");
    expect(deriveAuthCookiePrefix("PAP-1601-worktree")).toBe("paperclip-PAP-1601-worktree");
  });

  it("uses PAPERCLIP_INSTANCE_ID for the Better Auth cookie prefix", () => {
    process.env.PAPERCLIP_INSTANCE_ID = "sat-worktree";

    const advanced = buildBetterAuthAdvancedOptions({ disableSecureCookies: false });

    expect(advanced).toEqual({
      cookiePrefix: "paperclip-sat-worktree",
    });
    expect(getCookies({ advanced } as BetterAuthOptions).sessionToken.name).toBe(
      "paperclip-sat-worktree.session_token",
    );
  });

  it("keeps local http auth cookies non-secure while preserving the scoped prefix", () => {
    process.env.PAPERCLIP_INSTANCE_ID = "pap-worktree";

    expect(buildBetterAuthAdvancedOptions({ disableSecureCookies: true })).toEqual({
      cookiePrefix: "paperclip-pap-worktree",
      useSecureCookies: false,
    });
  });

  it("codifies the default session timeout and refresh policy", () => {
    expect(buildBetterAuthSessionOptions()).toEqual({
      expiresIn: DEFAULT_AUTH_SESSION_EXPIRES_IN_SECONDS,
      updateAge: DEFAULT_AUTH_SESSION_UPDATE_AGE_SECONDS,
      freshAge: DEFAULT_AUTH_SESSION_FRESH_AGE_SECONDS,
    });
  });

  it("allows authenticated session lifetimes to be tuned with positive integer env vars", () => {
    process.env.PAPERCLIP_AUTH_SESSION_EXPIRES_IN_SECONDS = "3600";
    process.env.PAPERCLIP_AUTH_SESSION_UPDATE_AGE_SECONDS = "300";
    process.env.PAPERCLIP_AUTH_SESSION_FRESH_AGE_SECONDS = "60";

    expect(buildBetterAuthSessionOptions()).toEqual({
      expiresIn: 3600,
      updateAge: 300,
      freshAge: 60,
    });
  });

  it("adds hostname port variants for authenticated mode on non-default ports", () => {
    const trustedOrigins = deriveAuthTrustedOrigins({
      deploymentMode: "authenticated",
      authBaseUrlMode: "auto",
      authPublicBaseUrl: undefined,
      allowedHostnames: ["Board.Example.Test"],
      port: 3101,
    } as Parameters<typeof deriveAuthTrustedOrigins>[0]);

    expect(trustedOrigins).toEqual(expect.arrayContaining([
      "https://board.example.test",
      "http://board.example.test",
      "https://board.example.test:3101",
      "http://board.example.test:3101",
    ]));
  });

  it("prefers an explicit resolved listen port over the configured port", () => {
    const trustedOrigins = deriveAuthTrustedOrigins({
      deploymentMode: "authenticated",
      authBaseUrlMode: "auto",
      authPublicBaseUrl: undefined,
      allowedHostnames: ["board.example.test"],
      port: 3100,
    } as Parameters<typeof deriveAuthTrustedOrigins>[0], { listenPort: 3101 });

    expect(trustedOrigins).toEqual(expect.arrayContaining([
      "https://board.example.test:3101",
      "http://board.example.test:3101",
    ]));
    expect(trustedOrigins).not.toContain("https://board.example.test:3100");
    expect(trustedOrigins).not.toContain("http://board.example.test:3100");
  });
});
