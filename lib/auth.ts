import { betterAuth } from "better-auth";
import { mongodbAdapter } from "@better-auth/mongo-adapter";
import { nextCookies } from "better-auth/next-js";
import { client } from "./mongo";

export const auth = betterAuth({
  // Local mongod is a standalone server (no replica set), so no `client` option
  // here: that would enable transactions, which standalone MongoDB doesn't support.
  database: mongodbAdapter(client.db()),
  emailAndPassword: {
    enabled: true,
  },
  // Must be the last plugin: lets Server Actions set auth cookies.
  plugins: [nextCookies()],
});
