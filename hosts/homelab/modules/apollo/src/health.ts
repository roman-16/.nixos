export function healthHandler(req: Request): Response {
  if (new URL(req.url).pathname === "/health") return new Response("ok");
  return new Response("apollo\n");
}
