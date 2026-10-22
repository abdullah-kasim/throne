import json
import mimetypes
import os
import pathlib
import shutil
import socket
import subprocess
import sys
import time
import urllib.parse
from email.utils import formatdate
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PAGE_FOLDER = pathlib.Path(__file__).resolve().parent
TAILNET_PATH = '/where-i-stand'
PAGE_FILE_NAME = 'where-i-stand.md'
RECORDS_FILE_NAME = 'where-i-stand-prs.json'
SAVE_ADDRESS = 'save'
SAVE_COMMAND = ['throne', 'where-i-stand', 'save']
BAD_INPUT_EXIT_CODE = 2
STATUS_FOR_OUTCOME = {'saved': 200, 'unchanged': 200, 'entry-changed': 409, 'lock-held': 409, 'frame-broken': 409}
WAIT_ATTEMPTS = 20
WAIT_INTERVAL_SECONDS = 0.25


def page_file():
    return pathlib.Path(os.environ.get('THRONE_DATA_HOME') or pathlib.Path.home() / '.throne') / PAGE_FILE_NAME


def cache_folder():
    return pathlib.Path(os.environ.get('XDG_CACHE_HOME') or pathlib.Path.home() / '.cache') / 'where-i-stand'


def records_file():
    return cache_folder() / RECORDS_FILE_NAME


def port_record():
    return cache_folder() / 'page-server.port'


def requested_name(request_path):
    return urllib.parse.urlsplit(request_path).path.lstrip('/')


def file_for_request(request_path):
    name = requested_name(request_path)
    if name in ('', 'index.html'):
        return PAGE_FOLDER / 'index.html'
    if name == PAGE_FILE_NAME:
        return page_file()
    if name == RECORDS_FILE_NAME:
        return records_file()
    if '/' in name:
        return None
    return PAGE_FOLDER / name


def content_type_of(file):
    kind = mimetypes.guess_type(file.name)[0] or 'text/plain'
    return f'{kind}; charset=utf-8' if kind.startswith('text/') or kind.endswith('json') else kind


def failed(message):
    return {'outcome': 'failed', 'message': message}


def status_for_save(exit_code, answer):
    if exit_code == BAD_INPUT_EXIT_CODE:
        return 400
    return STATUS_FOR_OUTCOME.get(answer.get('outcome'), 500)


def answer_save(body):
    try:
        result = subprocess.run(SAVE_COMMAND, input=body, capture_output=True, check=False)
    except OSError as error:
        return 500, failed(f'The save command could not run: {error}.')
    try:
        answer = json.loads(result.stdout)
    except ValueError:
        return 500, failed('The save command did not say what happened, so nothing is known to be saved.')
    return status_for_save(result.returncode, answer), answer


class Handler(BaseHTTPRequestHandler):
    def send(self, code, data, kind, last_modified=None):
        self.send_response(code)
        self.send_header('Content-Type', kind)
        self.send_header('Cache-Control', 'no-store')
        if last_modified is not None:
            self.send_header('Last-Modified', formatdate(last_modified, usegmt=True))
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        file = file_for_request(self.path)
        if file is None or not file.is_file():
            self.send(404, b'not found\n', 'text/plain; charset=utf-8')
            return
        self.send(200, file.read_bytes(), content_type_of(file), file.stat().st_mtime)

    def do_POST(self):
        if requested_name(self.path) != SAVE_ADDRESS:
            self.send(404, b'not found\n', 'text/plain; charset=utf-8')
            return
        body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        code, answer = answer_save(body)
        self.send(code, (json.dumps(answer) + '\n').encode(), 'application/json')

    def log_message(self, *arguments):
        pass


def serve(port):
    ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()


def fail(message):
    print(f'page server: {message}', file=sys.stderr)
    sys.exit(1)


def run(*command):
    return subprocess.run(command, check=False, capture_output=True, text=True)


def require_tailscale():
    if not shutil.which('tailscale') or run('tailscale', 'status', '--self').returncode != 0:
        fail('tailscale is not on PATH or not connected')


def page_url():
    status = json.loads(run('tailscale', 'status', '--self', '--json').stdout)
    return 'https://' + status['Self']['DNSName'].rstrip('.') + TAILNET_PATH + '/'


def free_local_port():
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        return probe.getsockname()[1]


def tailnet_path_is_served():
    status = json.loads(run('tailscale', 'serve', 'status', '--json').stdout or '{}')
    return any(
        path.rstrip('/') == TAILNET_PATH
        for host in (status.get('Web') or {}).values()
        for path in host.get('Handlers') or {}
    )


def answers_ok(url):
    return run('curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', url).stdout == '200'


def wait_until_answers_ok(url):
    for _ in range(WAIT_ATTEMPTS):
        if answers_ok(url):
            return True
        time.sleep(WAIT_INTERVAL_SECONDS)
    return answers_ok(url)


def is_this_scripts_server(process_id):
    return f'{pathlib.Path(__file__).resolve()} serve ' in run('ps', '-ww', '-o', 'command=', '-p', process_id).stdout


def stop():
    if not port_record().exists():
        return f'no page server was started here for {TAILNET_PATH}'
    port = port_record().read_text().strip()
    run('tailscale', 'serve', '--bg', '--set-path', TAILNET_PATH, 'off')
    for process_id in run('lsof', '-t', '-nP', f'-iTCP:{port}', '-sTCP:LISTEN').stdout.split():
        if is_this_scripts_server(process_id):
            run('kill', process_id)
    port_record().unlink()
    return f'stopped {TAILNET_PATH}'


def stop_after_a_failed_start(server, message):
    server.kill()
    stop()
    fail(message)


def start():
    require_tailscale()
    if tailnet_path_is_served() and not port_record().exists():
        fail(f'the tailnet path {TAILNET_PATH} is already served by something this script did not start')
    stop()
    cache_folder().mkdir(parents=True, exist_ok=True)
    port = free_local_port()
    log_file = cache_folder() / 'page-server.log'
    with open(log_file, 'w') as log:
        server = subprocess.Popen(
            [sys.executable, str(pathlib.Path(__file__).resolve()), 'serve', str(port)],
            stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
        )
    port_record().write_text(f'{port}\n')
    if not wait_until_answers_ok(f'http://127.0.0.1:{port}/'):
        stop_after_a_failed_start(server, f'the local server did not start; see {log_file}')
    run('tailscale', 'serve', '--bg', '--set-path', TAILNET_PATH, f'http://127.0.0.1:{port}')
    url = page_url()
    if not wait_until_answers_ok(url):
        stop_after_a_failed_start(server, f'the page did not answer 200 through {url}')
    return f'{url}\ntailnet only; local server on 127.0.0.1:{port}'


USAGE = '''Usage:
  page_server.py serve <port>
  page_server.py start
  page_server.py stop'''


def main(arguments):
    if arguments[:1] == ['serve'] and len(arguments) == 2:
        serve(int(arguments[1]))
    elif arguments == ['start']:
        print(start())
    elif arguments == ['stop']:
        print(stop())
    else:
        print(USAGE, file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
