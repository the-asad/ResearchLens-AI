/**
 * Postgres access for evaluation scripts. Reads DATABASE_URL tolerantly (unencoded '@' in the
 * password, or the dashboard's literal [brackets]) without ever printing it.
 */
import pg from "pg";

export function connectionConfig(): pg.ClientConfig {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const rest = url.split("://")[1];
  const at = rest.lastIndexOf("@");
  const cred = rest.slice(0, at);
  const hostPart = rest.slice(at + 1);
  const colon = cred.indexOf(":");
  let password = cred.slice(colon + 1);
  if (password.startsWith("[") && password.endsWith("]")) password = password.slice(1, -1);
  try {
    password = decodeURIComponent(password);
  } catch {
    /* keep raw */
  }
  const [hostPort, db] = hostPart.split("/");
  const [host, port] = hostPort.split(":");
  return { user: cred.slice(0, colon), password, host, port: Number(port ?? 5432), database: (db ?? "postgres").split("?")[0], ssl: { rejectUnauthorized: false } };
}

export async function connect() {
  const client = new pg.Client(connectionConfig());
  await client.connect();
  return client;
}

/**
 * Run a query AS a given end user: role `authenticated` + JWT claims, inside a transaction, so
 * RLS and auth.uid() behave exactly as for an API request from that user.
 */
export async function asUser<T extends pg.QueryResultRow>(client: pg.Client, userId: string, sql: string, params: unknown[]) {
  await client.query("begin");
  try {
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated" })]);
    const res = await client.query<T>(sql, params);
    await client.query("commit");
    return res.rows;
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
}
