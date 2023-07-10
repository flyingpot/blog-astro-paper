import { createClient } from "tinacms/dist/client";
import { queries } from "./types";
export const client = createClient({ url: 'http://localhost:4001/graphql', token: 'a3a3ec0d278a7f2c3affe2af2437a5c26535b79f', queries });
export default client;
  