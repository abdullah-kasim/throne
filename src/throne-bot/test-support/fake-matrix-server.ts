import http from 'node:http';

export interface FakeMatrixServer {
  url: string;
  close(): Promise<void>;
}

const REGISTRATION_SESSION = 'fake-registration-session';

interface ParsedBody {
  username?: string;
  auth?: { type?: string; session?: string };
}

export function startFakeMatrixServer(): Promise<FakeMatrixServer> {
  return new Promise((resolve, reject) => {
    let roomCounter = 0;
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const rawBody = Buffer.concat(chunks);
        const url = new URL(req.url ?? '/', 'http://fake-matrix-server');
        const send = (status: number, payload: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(payload));
        };

        if (req.method === 'POST' && url.pathname === '/_matrix/client/v3/register') {
          let body: ParsedBody = {};
          try {
            body = JSON.parse(rawBody.toString('utf8') || '{}') as ParsedBody;
          } catch {
            body = {};
          }
          if (
            body.auth?.type === 'm.login.registration_token' &&
            body.auth.session === REGISTRATION_SESSION
          ) {
            send(200, {
              user_id: `@${body.username}:fake-matrix-server`,
              access_token: `token-${body.username}`,
              device_id: 'FAKEDEVICE',
            });
            return;
          }
          send(401, {
            errcode: 'M_FORBIDDEN',
            error: 'registration token required',
            session: REGISTRATION_SESSION,
            flows: [{ stages: ['m.login.registration_token'] }],
          });
          return;
        }

        if (req.method === 'POST' && url.pathname === '/_matrix/client/v3/createRoom') {
          roomCounter += 1;
          send(200, { room_id: `!room${roomCounter}:fake-matrix-server` });
          return;
        }

        if (
          req.method === 'PUT' &&
          /^\/_matrix\/client\/v3\/rooms\/[^/]+\/send\/[^/]+\/[^/]+$/.test(url.pathname)
        ) {
          send(200, { event_id: `$event-${Date.now()}-${Math.random()}` });
          return;
        }

        if (req.method === 'POST' && url.pathname === '/_matrix/media/v3/upload') {
          send(200, { content_uri: 'mxc://fake-matrix-server/abc123' });
          return;
        }

        send(404, {
          errcode: 'M_NOT_FOUND',
          error: `no fake route for ${req.method ?? '?'} ${url.pathname}`,
        });
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('fake matrix server failed to bind to a port'));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
      });
    });
  });
}
