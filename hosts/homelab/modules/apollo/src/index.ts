export const port = Number(process.env.PORT ?? 8080);

export function handler(req: Request): Response {
  if (new URL(req.url).pathname === "/health") return new Response("ok");
  return new Response("hello from apollo\n");
}

if (import.meta.main) {
  Bun.serve({ port, fetch: handler });
  console.log(`apollo listening on :${port}`);
}
