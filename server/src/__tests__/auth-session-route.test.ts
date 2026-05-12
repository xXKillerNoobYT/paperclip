import express from "express";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  authSessions,
  companyMemberships,
  createDb as createDrizzleDb,
  instanceUserRoles,
} from "@paperclipai/db";
import {
  createBetterAuthHandler,
  createBetterAuthInstance,
  resolveBetterAuthSession,
} from "../auth/better-auth.js";
import { actorMiddleware } from "../middleware/auth.js";
import { authRoutes } from "../routes/auth.js";
import { errorHandler } from "../middleware/index.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

function createSelectChain(rows: unknown[]) {
  return {
    from() {
      return {
        where() {
          return Promise.resolve(rows);
        },
      };
    },
  };
}

function createDb() {
  return {
    select: vi
      .fn()
      .mockImplementationOnce(() => createSelectChain([]))
      .mockImplementationOnce(() => createSelectChain([])),
  } as any;
}

describe("actorMiddleware authenticated session profile", () => {
  const originalCloudTenantToken = process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN;

  afterEach(() => {
    if (originalCloudTenantToken === undefined) delete process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN;
    else process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN = originalCloudTenantToken;
  });

  it("preserves the signed-in user name and email on the board actor", async () => {
    const app = express();
    app.use(
      actorMiddleware(createDb(), {
        deploymentMode: "authenticated",
        resolveSession: async () => ({
          session: { id: "session-1", userId: "user-1" },
          user: {
            id: "user-1",
            name: "User One",
            email: "user@example.com",
          },
        }),
      }),
    );
    app.get("/actor", (req, res) => {
      res.json(req.actor);
    });

    const res = await request(app).get("/actor");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "board",
      userId: "user-1",
      userName: "User One",
      userEmail: "user@example.com",
      source: "session",
      companyIds: [],
      memberships: [],
      isInstanceAdmin: false,
    });
  });

  it("trusts Cloud tenant identity headers and seeds board access", async () => {
    process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN = "tenant-token";
    const inserts: Array<{ values: Record<string, unknown> }> = [];
    const db = {
      insert: vi.fn(() => {
        const chain = {
          values(values: Record<string, unknown>) {
            inserts.push({ values });
            return chain;
          },
          onConflictDoUpdate() {
            return chain;
          },
          onConflictDoNothing() {
            return chain;
          },
          returning() {
            return Promise.resolve([{
              companyId: inserts.at(-1)?.values.companyId,
              membershipRole: inserts.at(-1)?.values.membershipRole,
              status: inserts.at(-1)?.values.status,
            }]);
          },
        };
        return chain;
      }),
      select: vi.fn(),
    } as any;
    const app = express();
    app.use(
      actorMiddleware(db, {
        deploymentMode: "authenticated",
        resolveSession: async () => null,
      }),
    );
    app.get("/actor", (req, res) => {
      res.json(req.actor);
    });

    const res = await request(app)
      .get("/actor")
      .set("x-paperclip-cloud-tenant-token", "tenant-token")
      .set("x-paperclip-cloud-user-id", "global-user-1")
      .set("x-paperclip-cloud-user-email", "owner@example.com")
      .set("x-paperclip-cloud-user-name", "Stack Owner")
      .set("x-paperclip-cloud-stack-id", "stack-alpha")
      .set("x-paperclip-cloud-paperclip-company-id", "paperclip-stack-alpha")
      .set("x-paperclip-cloud-stack-role", "owner");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "board",
      userId: "global-user-1",
      userName: "Stack Owner",
      userEmail: "owner@example.com",
      source: "cloud_tenant",
      isInstanceAdmin: true,
      memberships: [expect.objectContaining({ membershipRole: "owner", status: "active" })],
    });
    expect(res.body.companyIds[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(inserts).toHaveLength(4);
    expect(inserts[0]?.values).toMatchObject({
      id: "global-user-1",
      email: "owner@example.com",
      emailVerified: true,
    });
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("authenticated board session baseline", () => {
  const originalBetterAuthSecret = process.env.BETTER_AUTH_SECRET;
  const originalSessionExpiresIn = process.env.PAPERCLIP_AUTH_SESSION_EXPIRES_IN_SECONDS;
  const originalSessionUpdateAge = process.env.PAPERCLIP_AUTH_SESSION_UPDATE_AGE_SECONDS;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDrizzleDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-auth-session-");
    db = createDrizzleDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(companyMemberships);
    await db.delete(instanceUserRoles);
    await db.delete(authSessions);
    if (originalBetterAuthSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = originalBetterAuthSecret;
    if (originalSessionExpiresIn === undefined) delete process.env.PAPERCLIP_AUTH_SESSION_EXPIRES_IN_SECONDS;
    else process.env.PAPERCLIP_AUTH_SESSION_EXPIRES_IN_SECONDS = originalSessionExpiresIn;
    if (originalSessionUpdateAge === undefined) delete process.env.PAPERCLIP_AUTH_SESSION_UPDATE_AGE_SECONDS;
    else process.env.PAPERCLIP_AUTH_SESSION_UPDATE_AGE_SECONDS = originalSessionUpdateAge;
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createAuthenticatedApp() {
    process.env.BETTER_AUTH_SECRET = "auth-session-route-test-secret";
    process.env.PAPERCLIP_AUTH_SESSION_EXPIRES_IN_SECONDS = "120";
    process.env.PAPERCLIP_AUTH_SESSION_UPDATE_AGE_SECONDS = "60";

    const auth = createBetterAuthInstance(
      db,
      {
        deploymentMode: "authenticated",
        authBaseUrlMode: "auto",
        authPublicBaseUrl: undefined,
        authDisableSignUp: false,
        allowedHostnames: [],
        port: 3100,
      } as Parameters<typeof createBetterAuthInstance>[1],
      [],
    );
    const app = express();
    app.use(express.json());
    app.use(
      actorMiddleware(db, {
        deploymentMode: "authenticated",
        resolveSession: (req) => resolveBetterAuthSession(auth, req),
      }),
    );
    app.use("/api/auth", authRoutes(db));
    app.all("/api/auth/{*authPath}", createBetterAuthHandler(auth));
    app.get("/api/protected", (req, res) => {
      if (req.actor.type !== "board" || !req.actor.userId) {
        res.status(401).json({ error: "Board authentication required" });
        return;
      }
      res.json({ ok: true, userId: req.actor.userId, source: req.actor.source });
    });
    app.use(errorHandler);
    return app;
  }

  async function signUpBoardSession() {
    const app = createAuthenticatedApp();
    const setupAgent = request.agent(app);
    const agent = request.agent(app);
    const email = `board-${randomUUID()}@example.com`;
    const password = "correct horse battery staple";
    const signUp = await setupAgent
      .post("/api/auth/sign-up/email")
      .send({ name: "Board User", email, password });

    expect(signUp.status, signUp.text || JSON.stringify(signUp.body)).toBe(200);
    await db.delete(authSessions);
    const signIn = await agent
      .post("/api/auth/sign-in/email")
      .send({ email, password });
    expect(signIn.status, signIn.text || JSON.stringify(signIn.body)).toBe(200);
    const sessions = await db.select().from(authSessions);
    expect(sessions).toHaveLength(1);
    return { agent, session: sessions[0]! };
  }

  it("supports sign-in then an authenticated API call through the Better Auth session cookie", async () => {
    const { agent } = await signUpBoardSession();

    const res = await agent.get("/api/protected");

    expect(res.status, res.text || JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ ok: true, source: "session" });
  });

  it("rejects expired session cookies", async () => {
    const { agent, session } = await signUpBoardSession();

    await db
      .update(authSessions)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(authSessions.id, session.id));

    const res = await agent.get("/api/protected");

    expect(res.status).toBe(401);
  });

  it("refreshes near-expiry sessions when the update window has elapsed", async () => {
    const { agent, session } = await signUpBoardSession();
    const nearExpiry = new Date(Date.now() + 1_000);
    await db
      .update(authSessions)
      .set({ expiresAt: nearExpiry })
      .where(eq(authSessions.id, session.id));

    const res = await agent.get("/api/protected");

    expect(res.status, res.text || JSON.stringify(res.body)).toBe(200);
    const refreshed = await db
      .select()
      .from(authSessions)
      .where(eq(authSessions.id, session.id))
      .then((rows) => rows[0]!);
    expect(refreshed.expiresAt.getTime()).toBeGreaterThan(nearExpiry.getTime());
  });
});
