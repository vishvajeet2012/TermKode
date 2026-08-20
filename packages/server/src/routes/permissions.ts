import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  allowRule,
  clearPermissionRules,
  denyRule,
  forgetRule,
  readPermissionRules,
} from "../lib/permissions-store";

// The CLI asks the user; this route is what makes the answer outlive the
// session. Rules are kept in ~/.termkode/permissions.json, next to the sessions
// they govern, and can be read or edited by hand.

const ruleSchema = z.object({
  rule: z.string().trim().min(1).max(200),
});

const ruleValidator = zValidator("json", ruleSchema, (result, c) => {
  if (!result.success) {
    return c.json({ error: "Provide a rule to store" }, 400);
  }
});

const app = new Hono()
  .get("/", (c) => {
    return c.json(readPermissionRules());
  })
  .post("/allow", ruleValidator, (c) => {
    return c.json(allowRule(c.req.valid("json").rule));
  })
  .post("/deny", ruleValidator, (c) => {
    return c.json(denyRule(c.req.valid("json").rule));
  })
  .post("/forget", ruleValidator, (c) => {
    return c.json(forgetRule(c.req.valid("json").rule));
  })
  .delete("/", (c) => {
    return c.json(clearPermissionRules());
  });

export default app;
