import http from 'node:http';

export function startWorkerHealthServer(port: number, isReady: () => boolean): http.Server {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/health/live') {
      res.writeHead(200).end(JSON.stringify({ ok: true }));
    } else if (req.url === '/health/ready') {
      const ready = isReady();
      res.writeHead(ready ? 200 : 503).end(JSON.stringify({ ready }));
    } else {
      res.writeHead(404).end();
    }
  });
  server.listen(port);
  return server;
}
