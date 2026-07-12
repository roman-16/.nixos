const port = Number(process.env.PORT ?? 8080);

Bun.serve({
  port,
  fetch(req) {
    if (new URL(req.url).pathname === "/health") return new Response("ok");
    return new Response("hello from apollo\n");
  },
});

console.log(`apollo listening on :${port}`);
